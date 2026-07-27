package projectchat

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	requestTimeout       = 10 * time.Second
	maxCredentialBytes   = 16 * 1024
	maxIdempotencyBytes  = 128
	threadIDHeader       = "X-Codex-Thread-ID"
	machineIDHeader      = "X-Project-Machine-ID"
	idempotencyKeyHeader = "Idempotency-Key"
	joinPath             = "/api/project-chat/join"
	presencePath         = "/api/project-chat/presence"
	messagesPath         = "/api/project-chat/messages"
	acknowledgementPath  = "/api/project-chat/ack"
	namesPath            = "/api/project-chat/names"
	nameClaimsPath       = "/api/project-chat/name-claims"
)

type Config struct {
	BaseURL            string
	HTTPClient         *http.Client
	CredentialProvider CredentialProvider
	MachineID          string
}

func (client *Client) ListNames(ctx context.Context, threadID string) (NameCatalog, error) {
	if err := validateThreadID(threadID); err != nil {
		return NameCatalog{}, err
	}
	response := NameCatalog{}
	if err := client.doJSON(ctx, http.MethodGet, namesPath, nil, threadID, "", nil, &response); err != nil {
		return NameCatalog{}, err
	}
	if !validNameCatalog(response) {
		return NameCatalog{}, ErrInvalidResponse
	}
	return response, nil
}

func (client *Client) ClaimName(ctx context.Context, threadID, name string, category NameCategory, parentThreadID string) (NameClaim, error) {
	if validateThreadID(threadID) != nil || name == "" || !validNameCategory(category) {
		return NameClaim{}, ErrInvalidRequest
	}
	if parentThreadID != "" && validateThreadID(parentThreadID) != nil {
		return NameClaim{}, ErrInvalidRequest
	}
	response := nameClaimResponse{}
	request := nameClaimRequest{Name: name, Category: category, ParentThreadID: parentThreadID}
	if err := client.doJSON(ctx, http.MethodPost, nameClaimsPath, nil, threadID, "", request, &response); err != nil {
		return NameClaim{}, err
	}
	if response.Claim.ThreadID != threadID || response.Claim.Name == "" || response.Claim.DisplayName == "" || !validNameCategory(response.Claim.Category) {
		return NameClaim{}, ErrInvalidResponse
	}
	return response.Claim, nil
}

func validNameCategory(category NameCategory) bool {
	return category == NameCategoryMythology || category == NameCategoryArtist || category == NameCategoryScience || category == NameCategoryDetective
}

func validNameCatalog(catalog NameCatalog) bool {
	if len(catalog.Groups) == 0 {
		return false
	}
	for _, group := range catalog.Groups {
		if !validNameCategory(group.Category) {
			return false
		}
		for _, entry := range group.Names {
			if entry.Name == "" || entry.Category != group.Category || (entry.State != "available" && entry.State != "claimed" && entry.State != "reserved") {
				return false
			}
		}
	}
	return true
}

type Client struct {
	baseURL     *url.URL
	httpClient  *http.Client
	credentials CredentialProvider
	machineID   string
}

func NewClient(config Config) (*Client, error) {
	baseURL, err := parseBaseURL(config.BaseURL)
	if err != nil {
		return nil, err
	}
	if config.CredentialProvider == nil {
		return nil, ErrMissingCredential
	}
	if config.MachineID == "" {
		return nil, ErrMissingMachineID
	}
	if !validMachineID(config.MachineID) {
		return nil, ErrInvalidMachineID
	}
	client := http.Client{}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
	}
	client.Timeout = requestTimeout
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		baseURL:     baseURL,
		httpClient:  &client,
		credentials: config.CredentialProvider,
		machineID:   config.MachineID,
	}, nil
}

func (client *Client) Join(ctx context.Context, threadID string, profile AgentProfile) error {
	if err := validateThreadID(threadID); err != nil {
		return err
	}
	if err := validateAgentProfile(profile); err != nil {
		return err
	}
	response := joinResponse{}
	request := joinRequest{DisplayName: profile.DisplayName, TaskTitle: profile.TaskTitle}
	if err := client.doJSON(ctx, http.MethodPost, joinPath, nil, threadID, "", request, &response); err != nil {
		return err
	}
	if response.Channel.ChannelID != GeneralChannel || validateAgentSender(response.Member, threadID) != nil {
		return ErrInvalidResponse
	}
	return nil
}

func (client *Client) UpdatePresence(ctx context.Context, threadID string, profile AgentProfile) error {
	if err := validateThreadID(threadID); err != nil {
		return err
	}
	if err := validateAgentProfile(profile); err != nil {
		return err
	}
	response := Sender{}
	var taskTitle *string
	if profile.TaskTitle != "" {
		taskTitle = &profile.TaskTitle
	}
	request := presenceRequest{State: "working", TaskTitle: taskTitle}
	if err := client.doJSON(ctx, http.MethodPost, presencePath, nil, threadID, "", request, &response); err != nil {
		return err
	}
	if err := validateAgentSender(response, threadID); err != nil {
		return ErrInvalidResponse
	}
	return nil
}

func (client *Client) Send(
	ctx context.Context,
	threadID string,
	channelID string,
	body string,
	idempotencyKey string,
) (Message, error) {
	if err := validateThreadID(threadID); err != nil {
		return Message{}, err
	}
	if err := validateChannelID(channelID); err != nil {
		return Message{}, err
	}
	if strings.TrimSpace(body) == "" {
		return Message{}, ErrInvalidMessage
	}
	if utf16Length(body) > MaxMessageCharacters {
		return Message{}, ErrMessageTooLarge
	}
	if err := validateIdempotencyKey(idempotencyKey); err != nil {
		return Message{}, err
	}

	request := sendRequest{
		ChannelID:      channelID,
		Body:           body,
		IdempotencyKey: idempotencyKey,
	}
	response := sendResponse{}
	if err := client.doJSON(ctx, http.MethodPost, messagesPath, nil, threadID, idempotencyKey, request, &response); err != nil {
		return Message{}, err
	}
	if err := validateMessage(response.Message, channelID); err != nil {
		return Message{}, err
	}
	return response.Message, nil
}

func (client *Client) Read(
	ctx context.Context,
	threadID string,
	channelID string,
	limit int,
) (ReadResult, error) {
	if err := validateThreadID(threadID); err != nil {
		return ReadResult{}, err
	}
	if err := validateChannelID(channelID); err != nil {
		return ReadResult{}, err
	}
	if limit < 1 || limit > MaxReadLimit {
		return ReadResult{}, ErrInvalidRequest
	}
	query := url.Values{
		"channelId": []string{channelID},
		"limit":     []string{strconv.Itoa(limit)},
	}
	response := ReadResult{}
	if err := client.doJSON(ctx, http.MethodGet, messagesPath, query, threadID, "", nil, &response); err != nil {
		return ReadResult{}, err
	}
	if err := validateReadResult(response, channelID, limit); err != nil {
		return ReadResult{}, err
	}
	return response, nil
}

func (client *Client) Acknowledge(
	ctx context.Context,
	threadID string,
	channelID string,
	throughSequence uint64,
) error {
	if err := validateThreadID(threadID); err != nil {
		return err
	}
	if err := validateChannelID(channelID); err != nil {
		return err
	}
	if throughSequence == 0 {
		return ErrInvalidRequest
	}
	request := acknowledgementRequest{
		ChannelID:       channelID,
		ThroughSequence: throughSequence,
	}
	response := acknowledgementResponse{}
	if err := client.doJSON(ctx, http.MethodPost, acknowledgementPath, nil, threadID, "", request, &response); err != nil {
		return err
	}
	if response.ChannelID != channelID || response.Sequence < throughSequence {
		return ErrInvalidResponse
	}
	return nil
}

func (client *Client) doJSON(
	ctx context.Context,
	method string,
	path string,
	query url.Values,
	threadID string,
	idempotencyKey string,
	payload any,
	result any,
) error {
	accessToken, err := client.credentials.AccessToken(ctx)
	if err != nil {
		return ErrMissingCredential
	}
	if err := validateCredential(accessToken); err != nil {
		return err
	}

	var requestBody io.Reader
	if payload != nil {
		encoded, encodeErr := json.Marshal(payload)
		if encodeErr != nil {
			return ErrInvalidRequest
		}
		requestBody = bytes.NewReader(encoded)
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	endpoint.RawPath = ""
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), requestBody)
	if err != nil {
		return ErrInvalidRequest
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set(threadIDHeader, threadID)
	request.Header.Set(machineIDHeader, client.machineID)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if idempotencyKey != "" {
		request.Header.Set(idempotencyKeyHeader, idempotencyKey)
	}

	response, err := client.httpClient.Do(request)
	if err != nil {
		if contextError := ctx.Err(); contextError != nil {
			return contextError
		}
		return ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices && response.StatusCode < http.StatusBadRequest {
		return ErrRedirectRejected
	}
	body, err := readLimited(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return mapAPIError(response.StatusCode, body)
	}
	if result == nil {
		return nil
	}
	if len(body) == 0 || json.Unmarshal(body, result) != nil {
		return ErrInvalidResponse
	}
	return nil
}
