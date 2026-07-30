package machinepower

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var (
	ErrInvalidConfig   = errors.New("invalid machine power client configuration")
	ErrInvalidInput    = errors.New("invalid machine power input")
	ErrInvalidResponse = errors.New("invalid machine power response")
	ErrUnauthorized    = errors.New("machine power authorization failed")
	ErrUnavailable     = errors.New("machine power service unavailable")
)

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
	operationPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$`)
)

type CredentialProvider interface {
	AccessToken(context.Context) (string, error)
}

type CredentialProviderFunc func(context.Context) (string, error)

func (provider CredentialProviderFunc) AccessToken(ctx context.Context) (string, error) {
	return provider(ctx)
}

type Config struct {
	BaseURL            string
	CallerMachineID    string
	CredentialProvider CredentialProvider
	HTTPClient         *http.Client
}

type Client struct {
	baseURL         *url.URL
	callerMachineID string
	credentials     CredentialProvider
	httpClient      *http.Client
}

func NewClient(config Config) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || baseURL.Host == "" ||
		(baseURL.Scheme != "http" && baseURL.Scheme != "https") ||
		baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" ||
		!identifierPattern.MatchString(config.CallerMachineID) || config.CredentialProvider == nil {
		return nil, ErrInvalidConfig
	}
	if baseURL.Scheme != "https" && baseURL.Hostname() != "localhost" &&
		baseURL.Hostname() != "127.0.0.1" && baseURL.Hostname() != "::1" {
		return nil, ErrInvalidConfig
	}
	httpClient := http.Client{Timeout: 30 * time.Second}
	if config.HTTPClient != nil {
		httpClient = *config.HTTPClient
		if httpClient.Timeout == 0 {
			httpClient.Timeout = 30 * time.Second
		}
	}
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/")
	return &Client{
		baseURL: baseURL, callerMachineID: config.CallerMachineID,
		credentials: config.CredentialProvider, httpClient: &httpClient,
	}, nil
}

func (client *Client) Status(ctx context.Context, selector Selector) (StatusResult, error) {
	if validateSelector(selector) != nil {
		return StatusResult{}, ErrInvalidInput
	}
	query := url.Values{}
	if selector.PhysicalMachineID != "" {
		query.Set("physicalMachineId", selector.PhysicalMachineID)
	} else {
		query.Set("physicalMachineName", selector.PhysicalMachineName)
	}
	result := StatusResult{}
	if err := client.do(ctx, http.MethodGet, query, "", nil, &result); err != nil {
		return StatusResult{}, err
	}
	if !validStatus(result) {
		return StatusResult{}, ErrInvalidResponse
	}
	return result, nil
}

func (client *Client) Request(ctx context.Context, input Request) (OperationResult, error) {
	if validateSelector(input.Selector) != nil ||
		!operationPattern.MatchString(input.OperationID) ||
		(input.RequestedState != "on" && input.RequestedState != "off") {
		return OperationResult{}, ErrInvalidInput
	}
	result := OperationResult{}
	if err := client.do(ctx, http.MethodPost, nil, input.OperationID, input, &result); err != nil {
		return OperationResult{}, err
	}
	if !validOperation(result) || result.OperationID != input.OperationID ||
		result.RequestedState != input.RequestedState {
		return OperationResult{}, ErrInvalidResponse
	}
	return result, nil
}

func (client *Client) do(
	ctx context.Context,
	method string,
	query url.Values,
	operationID string,
	body any,
	result any,
) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return ErrInvalidInput
		}
		reader = bytes.NewReader(encoded)
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + "/api/machine-power"
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), reader)
	if err != nil {
		return ErrInvalidInput
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || strings.TrimSpace(token) == "" {
		return ErrUnauthorized
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", operationID)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrUnavailable
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(encoded) > 1<<20 {
		return ErrInvalidResponse
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return ErrUnauthorized
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 500 {
			return ErrUnavailable
		}
		return ErrInvalidInput
	}
	if json.Unmarshal(encoded, result) != nil {
		return ErrInvalidResponse
	}
	return nil
}

func validateSelector(selector Selector) error {
	selected := 0
	if identifierPattern.MatchString(selector.PhysicalMachineID) {
		selected++
	} else if selector.PhysicalMachineID != "" {
		return ErrInvalidInput
	}
	if selector.PhysicalMachineName != "" {
		if strings.TrimSpace(selector.PhysicalMachineName) != selector.PhysicalMachineName ||
			len(selector.PhysicalMachineName) > 80 {
			return ErrInvalidInput
		}
		selected++
	}
	if selected != 1 {
		return ErrInvalidInput
	}
	return nil
}

func validStatus(result StatusResult) bool {
	if result.APIVersion != APIVersion || result.Machine.ID == "" ||
		result.Machine.Name == "" || result.Message == "" ||
		result.Provider.Kind != "jetkvm-mqtt" {
		return false
	}
	if result.Reconciliation != nil &&
		(result.State != "online" ||
			(result.Reconciliation.State != "complete" &&
				result.Reconciliation.State != "failed")) {
		return false
	}
	switch result.State {
	case "online", "offline", "unknown", "unsupported", "failed":
		return true
	default:
		return false
	}
}

func validOperation(result OperationResult) bool {
	if result.APIVersion != APIVersion || result.Machine.ID == "" ||
		result.Machine.Name == "" || result.Message == "" ||
		result.Provider.Kind != "jetkvm-mqtt" ||
		(result.Dispatch.BrokerAcknowledged && !result.Dispatch.Attempted) ||
		(result.State == "accepted" && !result.Dispatch.BrokerAcknowledged) {
		return false
	}
	switch result.State {
	case "accepted", "confirmed-online", "confirmed-offline",
		"unsupported", "failed", "uncertain":
		return true
	default:
		return false
	}
}
