package machinereadiness

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
	ErrInvalidConfig   = errors.New("invalid machine readiness client configuration")
	ErrInvalidInput    = errors.New("invalid machine readiness input")
	ErrInvalidResponse = errors.New("invalid machine readiness response")
	ErrUnauthorized    = errors.New("machine readiness authorization failed")
	ErrUnavailable     = errors.New("machine readiness service unavailable")
)

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
	operationPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$`)
	planPattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
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
	client := http.Client{Timeout: 30 * time.Second}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
		if client.Timeout == 0 {
			client.Timeout = 30 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/")
	return &Client{
		baseURL: baseURL, callerMachineID: config.CallerMachineID,
		credentials: config.CredentialProvider, httpClient: &client,
	}, nil
}

func (client *Client) Diagnose(ctx context.Context, selector Selector) (Result, error) {
	if err := validateSelector(selector); err != nil {
		return Result{}, err
	}
	query := url.Values{}
	if selector.ConnectorID != "" {
		query.Set("connectorId", selector.ConnectorID)
	}
	if selector.PhysicalMachineID != "" {
		query.Set("physicalMachineId", selector.PhysicalMachineID)
	}
	if selector.PhysicalMachineName != "" {
		query.Set("physicalMachineName", selector.PhysicalMachineName)
	}
	result := Result{}
	if err := client.do(ctx, http.MethodGet, query, "", nil, &result); err != nil {
		return Result{}, err
	}
	if err := validateResult(result); err != nil {
		return Result{}, err
	}
	return result, nil
}

func (client *Client) Fix(ctx context.Context, request FixRequest) (FixResult, error) {
	if validateSelector(request.Selector) != nil ||
		!operationPattern.MatchString(request.OperationID) ||
		!planPattern.MatchString(request.PlanID) {
		return FixResult{}, ErrInvalidInput
	}
	result := FixResult{}
	if err := client.do(
		ctx, http.MethodPost, nil, request.OperationID, request, &result,
	); err != nil {
		return FixResult{}, err
	}
	if result.APIVersion != APIVersion || result.OperationID != request.OperationID ||
		!validFixState(result.State) ||
		validateResult(result.Diagnosis) != nil {
		return FixResult{}, ErrInvalidResponse
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
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + "/api/machine-readiness"
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), reader)
	if err != nil {
		return ErrInvalidInput
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || !validOpaque(token) {
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
	if strings.TrimSpace(selector.PhysicalMachineID) != "" {
		selected++
	}
	if strings.TrimSpace(selector.PhysicalMachineName) != "" {
		selected++
	}
	if selected != 1 {
		return ErrInvalidInput
	}
	if selector.ConnectorID != "" && !identifierPattern.MatchString(selector.ConnectorID) {
		return ErrInvalidInput
	}
	if selector.PhysicalMachineID != "" &&
		!identifierPattern.MatchString(selector.PhysicalMachineID) {
		return ErrInvalidInput
	}
	if selector.PhysicalMachineName != "" &&
		(strings.TrimSpace(selector.PhysicalMachineName) != selector.PhysicalMachineName ||
			len(selector.PhysicalMachineName) > 80) {
		return ErrInvalidInput
	}
	return nil
}

func validateResult(result Result) error {
	if result.APIVersion != APIVersion || result.CheckedAt == "" ||
		result.Message == "" || !validState(result.State) {
		return ErrInvalidResponse
	}
	for _, check := range result.Checks {
		if !identifierPattern.MatchString(check.ConnectorID) ||
			check.ConnectorName == "" || !validCheckState(check.State) {
			return ErrInvalidResponse
		}
	}
	if result.Plan != nil {
		if !planPattern.MatchString(result.Plan.ID) || len(result.Plan.Actions) != 1 {
			return ErrInvalidResponse
		}
		action := result.Plan.Actions[0]
		if !identifierPattern.MatchString(action.ConnectorID) ||
			(action.Kind != "update-connector" && action.Kind != "restart-connector") ||
			(action.Operation != "update" && action.Operation != "restart") ||
			(action.Kind == "update-connector" &&
				(action.Operation != "update" || action.ReleaseID == "")) ||
			(action.Kind == "restart-connector" &&
				(action.Operation != "restart" || action.ReleaseID != "")) {
			return ErrInvalidResponse
		}
	}
	return nil
}

func validState(state State) bool {
	switch state {
	case StateReady, StateDegraded, StateRepairable, StateRepairing, StateRepaired,
		StateUnreachable, StateAuthorizationRequired, StateUnauthorized, StateUnsupported, StateFailed,
		StateUncertain, StateAmbiguous, StateManuallyBlocked, StateRollingBack,
		StateRolledBack, StateRecoveryRequired:
		return true
	default:
		return false
	}
}

func validCheckState(state string) bool {
	switch state {
	case "ready", "outdated", "missing", "repairable", "repairing", "unreachable",
		"authorization-required", "unauthorized", "unsupported", "failed", "uncertain",
		"manually-blocked", "rolling-back", "rolled-back", "recovery-required":
		return true
	default:
		return false
	}
}

func validFixState(state string) bool {
	switch state {
	case "converged", "repairing", "verification-pending", "repaired", "blocked", "failed",
		"rolled-back", "recovery-required":
		return true
	default:
		return false
	}
}

func validOpaque(value string) bool {
	return value != "" && strings.TrimSpace(value) == value &&
		!strings.ContainsAny(value, " \t\r\n")
}
