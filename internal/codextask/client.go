package codextask

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	attachTokenHeader                 = "X-Project-Codex-Attach-Token"
	callerMachineHeader               = "X-Project-Machine-ID"
	callerThreadHeader                = "X-Codex-Thread-ID"
	defaultMaximumResponseBytes int64 = 1 << 20
	defaultAuthorizationTimeout       = 30 * time.Second
	defaultRequestTimeout             = 15 * time.Second
	defaultStartTimeout               = 5 * time.Minute
	tasksPath                         = "/api/codex/tasks"
)

var safeErrorCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,127}$`)

type CredentialProvider interface {
	AccessToken(context.Context) (string, error)
}

type CredentialProviderFunc func(context.Context) (string, error)

func (provider CredentialProviderFunc) AccessToken(ctx context.Context) (string, error) {
	return provider(ctx)
}

type Config struct {
	BaseURL              string
	CallerMachineID      string
	CallerThreadID       string
	CredentialProvider   CredentialProvider
	HTTPClient           *http.Client
	MaximumResponseBytes int64
}

type Client struct {
	baseURL                 *url.URL
	authorizationHTTPClient *http.Client
	callerMachineID         string
	callerThreadID          string
	credentials             CredentialProvider
	httpClient              *http.Client
	maximumResponse         int64
	startHTTPClient         *http.Client
	streamHTTPClient        *http.Client
}

func NewClient(config Config) (*Client, error) {
	baseURL, err := parseBaseURL(config.BaseURL)
	if err != nil || !identifierPattern.MatchString(config.CallerMachineID) || config.CredentialProvider == nil {
		return nil, ErrInvalidConfig
	}
	if config.CallerThreadID != "" && !threadIDPattern.MatchString(config.CallerThreadID) {
		return nil, ErrInvalidConfig
	}
	maximum := config.MaximumResponseBytes
	if maximum == 0 {
		maximum = defaultMaximumResponseBytes
	}
	if maximum < 1 || maximum > 16<<20 {
		return nil, ErrInvalidConfig
	}
	client := http.Client{}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
	}
	configuredTimeout := client.Timeout
	if configuredTimeout == 0 {
		client.Timeout = defaultRequestTimeout
	}
	client.CheckRedirect = rejectRedirect
	startClient := client
	if configuredTimeout == 0 {
		startClient.Timeout = defaultStartTimeout
	}
	streamClient := client
	streamClient.Timeout = 0
	authorizationClient := client
	if configuredTimeout == 0 {
		authorizationClient.Timeout = defaultAuthorizationTimeout
	}
	return &Client{
		authorizationHTTPClient: &authorizationClient,
		baseURL:                 baseURL, callerMachineID: config.CallerMachineID,
		callerThreadID: config.CallerThreadID, credentials: config.CredentialProvider,
		httpClient: &client, maximumResponse: maximum, startHTTPClient: &startClient,
		streamHTTPClient: &streamClient,
	}, nil
}

func (client *Client) Start(ctx context.Context, request StartRequest) (StartResult, error) {
	if err := validateStartRequest(request); err != nil {
		return StartResult{}, err
	}
	result := StartResult{}
	if _, err := client.doJSON(ctx, client.startHTTPClient, http.MethodPost, tasksPath+"/start", nil, request.OperationID, request, &result); err != nil {
		return StartResult{}, err
	}
	if err := validateStartResult(result, request); err != nil {
		return StartResult{}, err
	}
	return result, nil
}

func (client *Client) Read(ctx context.Context, request ReadRequest) (ReadResult, error) {
	if err := validateReadRequest(request); err != nil {
		return ReadResult{}, err
	}
	query := selectorQuery(request.Selector)
	if request.Last > 0 {
		query.Set("last", strconv.Itoa(request.Last))
	}
	result := ReadResult{}
	endpoint := path.Join(tasksPath, request.ThreadID)
	if _, err := client.doJSON(ctx, client.httpClient, http.MethodGet, endpoint, query, "", nil, &result); err != nil {
		return ReadResult{}, err
	}
	if err := validateReadResult(result, request); err != nil {
		return ReadResult{}, err
	}
	return result, nil
}

func (client *Client) Send(ctx context.Context, request SendRequest) (SendResult, error) {
	if err := validateSendRequest(request); err != nil {
		return SendResult{}, err
	}
	result := SendResult{}
	endpoint := path.Join(tasksPath, request.ThreadID, "send")
	if _, err := client.doJSON(ctx, client.httpClient, http.MethodPost, endpoint, nil, request.OperationID, request, &result); err != nil {
		return SendResult{}, err
	}
	if err := validateSendResult(result, request); err != nil {
		return SendResult{}, err
	}
	return result, nil
}

func (client *Client) Attach(ctx context.Context, request AttachRequest) (AttachResult, error) {
	if err := validateAttachRequest(request); err != nil {
		return AttachResult{}, err
	}
	result := AttachResult{}
	endpoint := path.Join(tasksPath, request.ThreadID, "attach")
	headers, err := client.doJSON(ctx, client.httpClient, http.MethodPost, endpoint, nil, request.OperationID, request, &result)
	if err != nil {
		return AttachResult{}, err
	}
	tokens := headers.Values(attachTokenHeader)
	if len(tokens) > 1 {
		return AttachResult{}, ErrInvalidResponse
	}
	if len(tokens) == 1 {
		result.Token = tokens[0]
	}
	if err := validateAttachResult(result, request); err != nil {
		return AttachResult{}, err
	}
	if result.Transport == "websocket-tunnel" {
		remote := *client.baseURL
		if remote.Scheme == "https" {
			remote.Scheme = "wss"
		} else {
			remote.Scheme = "ws"
		}
		remote.Path, remote.RawPath, remote.RawQuery, remote.Fragment = result.EndpointPath, "", "", ""
		result.RemoteURL = remote.String()
	}
	return result, nil
}

func (client *Client) doJSON(
	ctx context.Context,
	httpClient *http.Client,
	method string,
	requestPath string,
	query url.Values,
	operationID string,
	payload any,
	result any,
) (http.Header, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, ErrInvalidInput
		}
		body = bytes.NewReader(encoded)
	}
	request, err := client.newRequest(ctx, method, requestPath, query, operationID, "application/json", body)
	if err != nil {
		return nil, err
	}
	response, err := httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrUnavailable
	}
	defer response.Body.Close()
	encoded, err := readBounded(response.Body, client.maximumResponse)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return nil, ErrRedirectRejected
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, requestError(response.StatusCode, encoded)
	}
	if result == nil {
		return response.Header.Clone(), nil
	}
	if len(encoded) == 0 || json.Unmarshal(encoded, result) != nil {
		return nil, ErrInvalidResponse
	}
	return response.Header.Clone(), nil
}

func (client *Client) newRequest(
	ctx context.Context,
	method string,
	requestPath string,
	query url.Values,
	operationID string,
	accept string,
	body io.Reader,
) (*http.Request, error) {
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || !validOpaque(token, 4096) {
		return nil, ErrUnauthorized
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + requestPath
	endpoint.RawPath = ""
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, ErrInvalidInput
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set(callerMachineHeader, client.callerMachineID)
	if client.callerThreadID != "" {
		request.Header.Set(callerThreadHeader, client.callerThreadID)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if operationID != "" {
		request.Header.Set("Idempotency-Key", operationID)
	}
	return request, nil
}

func selectorQuery(selector Selector) url.Values {
	query := url.Values{}
	if selector.ConnectorID != "" {
		query.Set("connectorId", selector.ConnectorID)
	}
	if selector.EnvironmentID != "" {
		query.Set("environmentId", selector.EnvironmentID)
	}
	if selector.PhysicalMachineID != "" {
		query.Set("physicalMachineId", selector.PhysicalMachineID)
	}
	if selector.PhysicalMachineName != "" {
		query.Set("physicalMachineName", selector.PhysicalMachineName)
	}
	return query
}

func parseBaseURL(value string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, ErrInvalidConfig
	}
	if parsed.Scheme != "https" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1" {
		return nil, ErrInvalidConfig
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func rejectRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

func readBounded(reader io.Reader, maximum int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil {
		return nil, ErrInvalidResponse
	}
	if int64(len(body)) > maximum {
		return nil, ErrResponseTooLarge
	}
	return body, nil
}

func requestError(status int, body []byte) error {
	envelope := struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}{}
	_ = json.Unmarshal(body, &envelope)
	code := envelope.Error.Code
	if !safeErrorCode.MatchString(code) {
		code = "request_failed"
	}
	var cause error
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		cause = ErrUnauthorized
	case status == http.StatusNotFound:
		cause = ErrNotFound
	case status == http.StatusConflict:
		cause = ErrConflict
	case status >= 500:
		cause = ErrUnavailable
	default:
		cause = ErrInvalidInput
	}
	return &RequestError{Code: code, StatusCode: status, cause: cause}
}

func validOpaque(value string, maximum int) bool {
	return value != "" && strings.TrimSpace(value) == value && len(value) <= maximum &&
		strings.IndexFunc(value, func(character rune) bool {
			return unicode.IsSpace(character) || unicode.IsControl(character)
		}) == -1
}

func validateStartResult(result StartResult, request StartRequest) error {
	if validateCommonResult(result.APIVersion, result.OperationID, result.State, result.Reason, result.Reconcile) != nil || result.OperationID != request.OperationID {
		return ErrInvalidResponse
	}
	switch result.State {
	case StateReady:
		if !request.DryRun || result.Target == nil || validateTarget(*result.Target) != nil ||
			!targetMatchesSelector(*result.Target, request.Selector) || result.Task != nil {
			return ErrInvalidResponse
		}
	case StateConfirmed:
		if request.DryRun || result.Task == nil || validateTask(*result.Task) != nil ||
			!targetMatchesSelector(result.Task.Target, request.Selector) ||
			result.Task.Issue.Number != request.Issue ||
			(request.RepositoryID != "" && result.Task.Repository.ID != request.RepositoryID && result.Task.Repository.NameWithOwner != request.RepositoryID) {
			return ErrInvalidResponse
		}
	case StateBlocked, StateUncertain:
		if !validText(result.Message, 2_048) {
			return ErrInvalidResponse
		}
	default:
		return ErrInvalidResponse
	}
	return nil
}

func validateReadResult(result ReadResult, request ReadRequest) error {
	if result.APIVersion != APIVersion {
		return ErrInvalidResponse
	}
	switch result.State {
	case StateConfirmed:
		if result.Target == nil || result.Result == nil || validateTarget(*result.Target) != nil ||
			!targetMatchesSelector(*result.Target, request.Selector) || !result.Result.OpenedReadOnly ||
			result.Result.Session.ID != request.ThreadID ||
			result.Result.Session.MachineID != result.Target.Connector.ID || result.Result.Turns == nil ||
			result.Message != "" || result.Reason != "" {
			return ErrInvalidResponse
		}
		return nil
	case StateBlocked:
		if !validBlockedReason(result.Reason) || !validText(result.Message, 2_048) ||
			result.Result != nil || result.Target != nil {
			return ErrInvalidResponse
		}
		return nil
	default:
		return ErrInvalidResponse
	}
}

func validateSendResult(result SendResult, request SendRequest) error {
	if validateCommonResult(result.APIVersion, result.OperationID, result.State, result.Reason, result.Reconcile) != nil || result.OperationID != request.OperationID {
		return ErrInvalidResponse
	}
	switch result.State {
	case StateAccepted:
		if result.Target == nil || validateTarget(*result.Target) != nil ||
			!targetMatchesSelector(*result.Target, request.Selector) ||
			result.ThreadID != request.ThreadID || result.TurnID == "" || result.Result != nil {
			return ErrInvalidResponse
		}
	case StateCompleted:
		if result.Target == nil || validateTarget(*result.Target) != nil ||
			!targetMatchesSelector(*result.Target, request.Selector) ||
			result.ThreadID != request.ThreadID || result.TurnID == "" || result.Result == nil ||
			!result.Result.OpenedReadOnly || result.Result.Session.ID != request.ThreadID ||
			result.Result.Session.MachineID != result.Target.Connector.ID || result.Result.Turns == nil {
			return ErrInvalidResponse
		}
	case StateBlocked, StateUncertain:
		if !validText(result.Message, 2_048) || result.Result != nil {
			return ErrInvalidResponse
		}
	default:
		return ErrInvalidResponse
	}
	return nil
}

func validateAttachResult(result AttachResult, request AttachRequest) error {
	if validateCommonResult(result.APIVersion, result.OperationID, result.State, result.Reason, "") != nil || result.OperationID != request.OperationID {
		return ErrInvalidResponse
	}
	if result.State == StateBlocked {
		if !validText(result.Message, 2_048) || result.Token != "" {
			return ErrInvalidResponse
		}
		return nil
	}
	if result.State != StateConfirmed || result.Target == nil || validateTarget(*result.Target) != nil ||
		!targetMatchesSelector(*result.Target, request.Selector) || result.ThreadID != request.ThreadID ||
		(result.Transport != "local-unix" && result.Transport != "websocket-tunnel") {
		return ErrInvalidResponse
	}
	if result.Transport == "local-unix" &&
		(result.EndpointPath != "" || result.Token != "" || result.TokenEnvironmentVariable != "") {
		return ErrInvalidResponse
	}
	if result.Transport == "websocket-tunnel" {
		expectedPath := path.Join(tasksPath, request.ThreadID, "attach", "socket")
		if result.EndpointPath != expectedPath || result.Token == "" ||
			result.TokenEnvironmentVariable != "PROJECT_CODEX_ATTACH_TOKEN" || result.SocketPath != "" {
			return ErrInvalidResponse
		}
	}
	if result.SocketPath != "" && (!filepath.IsAbs(result.SocketPath) || !validText(result.SocketPath, 4096)) {
		return ErrInvalidResponse
	}
	if result.Token != "" && !validOpaque(result.Token, 4096) {
		return ErrInvalidResponse
	}
	if result.TokenEnvironmentVariable != "" &&
		!regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`).MatchString(result.TokenEnvironmentVariable) {
		return ErrInvalidResponse
	}
	if _, err := time.Parse(time.RFC3339, result.ExpiresAt); err != nil {
		return ErrInvalidResponse
	}
	return nil
}
