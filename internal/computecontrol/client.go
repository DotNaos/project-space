package computecontrol

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
	ErrInvalidConfig   = errors.New("invalid compute control client configuration")
	ErrInvalidInput    = errors.New("invalid compute control request")
	ErrInvalidResponse = errors.New("invalid compute control response")
	ErrUnauthorized    = errors.New("compute control authorization failed")
	ErrUnavailable     = errors.New("compute control service unavailable")
)

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
	operationPattern  = regexp.MustCompile(`^[A-Za-z0-9:._-]{1,256}$`)
	revisionPattern   = regexp.MustCompile(`^[A-Za-z0-9:._-]{8,256}$`)
	uuidPattern       = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
)

type CredentialProvider interface {
	AccessToken(context.Context) (string, error)
}

type CredentialProviderFunc func(context.Context) (string, error)

func (provider CredentialProviderFunc) AccessToken(ctx context.Context) (string, error) {
	return provider(ctx)
}

type API interface {
	Status(context.Context, StatusRequest) (ExecutionResult, error)
}

type WorkspaceRuntimeAPI interface {
	SupportsWorkspaceRuntimePresentation(context.Context) bool
	LaunchWorkspaceRuntime(context.Context, WorkspaceRuntimeLaunchRequest) (WorkspaceRuntimeLaunchExecution, error)
}

type WorkspaceRuntimeClientAPI interface {
	PrepareClientOwnedWorkspaceRuntime(context.Context, WorkspaceRuntimeClientLaunchRequest) (WorkspaceRuntimeClientLaunchResult, error)
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
	httpClient := http.Client{Timeout: 70 * time.Second}
	if config.HTTPClient != nil {
		httpClient = *config.HTTPClient
		if httpClient.Timeout == 0 {
			httpClient.Timeout = 70 * time.Second
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

func (client *Client) Status(ctx context.Context, input StatusRequest) (ExecutionResult, error) {
	if !uuidPattern.MatchString(input.EnvironmentID) ||
		!operationPattern.MatchString(input.OperationID) {
		return ExecutionResult{}, ErrInvalidInput
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return ExecutionResult{}, ErrInvalidInput
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + "/api/compute/control/status"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(encoded))
	if err != nil {
		return ExecutionResult{}, ErrInvalidInput
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || strings.TrimSpace(token) == "" {
		return ExecutionResult{}, ErrUnauthorized
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", input.OperationID)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ExecutionResult{}, ctx.Err()
		}
		return ExecutionResult{}, ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return ExecutionResult{}, ErrUnauthorized
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 500 {
			return ExecutionResult{}, ErrUnavailable
		}
		return ExecutionResult{}, ErrInvalidInput
	}
	limited := io.LimitReader(response.Body, (1<<20)+1)
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	var result ExecutionResult
	if decoder.Decode(&result) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		!validResult(result, input, client.callerMachineID) {
		return ExecutionResult{}, ErrInvalidResponse
	}
	return result, nil
}

func (client *Client) LaunchWorkspaceRuntime(
	ctx context.Context,
	input WorkspaceRuntimeLaunchRequest,
) (WorkspaceRuntimeLaunchExecution, error) {
	if !validLaunchRequest(input) {
		return WorkspaceRuntimeLaunchExecution{}, ErrInvalidInput
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return WorkspaceRuntimeLaunchExecution{}, ErrInvalidInput
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") +
		"/api/compute/control/workspace-runtime/launch"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(encoded))
	if err != nil {
		return WorkspaceRuntimeLaunchExecution{}, ErrInvalidInput
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || strings.TrimSpace(token) == "" {
		return WorkspaceRuntimeLaunchExecution{}, ErrUnauthorized
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", input.OperationID)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return WorkspaceRuntimeLaunchExecution{}, ctx.Err()
		}
		return WorkspaceRuntimeLaunchExecution{}, ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return WorkspaceRuntimeLaunchExecution{}, ErrUnauthorized
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 500 {
			return WorkspaceRuntimeLaunchExecution{}, ErrUnavailable
		}
		return WorkspaceRuntimeLaunchExecution{}, ErrInvalidInput
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, (1<<20)+1))
	decoder.DisallowUnknownFields()
	var result WorkspaceRuntimeLaunchExecution
	if decoder.Decode(&result) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		!validLaunchResult(result, input) {
		return WorkspaceRuntimeLaunchExecution{}, ErrInvalidResponse
	}
	return result, nil
}

func (client *Client) PrepareClientOwnedWorkspaceRuntime(
	ctx context.Context,
	input WorkspaceRuntimeClientLaunchRequest,
) (WorkspaceRuntimeClientLaunchResult, error) {
	if !validClientLaunchRequest(input) {
		return WorkspaceRuntimeClientLaunchResult{}, ErrInvalidInput
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return WorkspaceRuntimeClientLaunchResult{}, ErrInvalidInput
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") +
		"/api/compute/control/workspace-runtime/client-launch"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(encoded))
	if err != nil {
		return WorkspaceRuntimeClientLaunchResult{}, ErrInvalidInput
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || strings.TrimSpace(token) == "" {
		return WorkspaceRuntimeClientLaunchResult{}, ErrUnauthorized
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", input.OperationID)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return WorkspaceRuntimeClientLaunchResult{}, ctx.Err()
		}
		return WorkspaceRuntimeClientLaunchResult{}, ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return WorkspaceRuntimeClientLaunchResult{}, ErrUnauthorized
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 500 {
			return WorkspaceRuntimeClientLaunchResult{}, ErrUnavailable
		}
		return WorkspaceRuntimeClientLaunchResult{}, ErrInvalidInput
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, (1<<20)+1))
	decoder.DisallowUnknownFields()
	var result WorkspaceRuntimeClientLaunchResult
	if decoder.Decode(&result) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		!validClientLaunchResult(result, input) {
		return WorkspaceRuntimeClientLaunchResult{}, ErrInvalidResponse
	}
	return result, nil
}

func (client *Client) SupportsWorkspaceRuntimePresentation(ctx context.Context) bool {
	probeContext, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") +
		"/api/compute/control/workspace-runtime/capabilities"
	request, err := http.NewRequestWithContext(probeContext, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return false
	}
	token, err := client.credentials.AccessToken(probeContext)
	if err != nil || strings.TrimSpace(token) == "" {
		return false
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, (1<<20)+1))
	decoder.DisallowUnknownFields()
	var result struct {
		Capabilities  []string `json:"capabilities"`
		SchemaVersion int      `json:"schemaVersion"`
	}
	if decoder.Decode(&result) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		result.SchemaVersion != 1 {
		return false
	}
	for _, capability := range result.Capabilities {
		if capability == "workspace-runtime-presentation.v1" {
			return true
		}
	}
	return false
}

func validLaunchRequest(value WorkspaceRuntimeLaunchRequest) bool {
	return uuidPattern.MatchString(value.EnvironmentID) && uuidPattern.MatchString(value.WorkspaceID) &&
		uuidPattern.MatchString(value.Generation) && operationPattern.MatchString(value.OperationID) &&
		regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`).MatchString(value.Commit) &&
		regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(value.ManifestDigest) &&
		regexp.MustCompile(`^[A-Za-z0-9._+-]{1,64}$`).MatchString(value.RuntimeVersion) &&
		(value.Mode == "process" || value.Mode == "devcontainer") &&
		(value.Profile == "codex" || value.Profile == "inspection" || value.Profile == "mutation") &&
		(value.Profile != "mutation" || uuidPattern.MatchString(value.WorktreeOwnerThreadID)) &&
		(value.WorktreeOwnerThreadID == "" || uuidPattern.MatchString(value.WorktreeOwnerThreadID)) &&
		value.Branch != "" && len(value.Branch) <= 256 && !strings.ContainsAny(value.Branch, "\x00\r\n")
}

func validClientLaunchRequest(value WorkspaceRuntimeClientLaunchRequest) bool {
	return validLaunchRequest(WorkspaceRuntimeLaunchRequest{
		Branch: value.Branch, Commit: value.Commit, EnvironmentID: value.EnvironmentID,
		Generation: value.Generation, ManifestDigest: value.ManifestDigest, Mode: value.Mode,
		OperationID: value.OperationID, Profile: value.Profile, RuntimeVersion: value.RuntimeVersion,
		WorkspaceID: value.WorkspaceID, WorktreeOwnerThreadID: value.WorktreeOwnerThreadID,
	}) && uuidPattern.MatchString(value.HostID) && revisionPattern.MatchString(value.TargetIdentityRevision) &&
		(value.Profile != "mutation" || uuidPattern.MatchString(value.WorktreeOwnerThreadID))
}

func validClientLaunchResult(
	value WorkspaceRuntimeClientLaunchResult,
	input WorkspaceRuntimeClientLaunchRequest,
) bool {
	expiresAt, parseErr := time.Parse(time.RFC3339Nano, value.RuntimeSessionExpiresAt)
	return value.Branch == input.Branch && value.Commit == input.Commit &&
		revisionPattern.MatchString(value.ControlTargetIdentityRevision) &&
		value.EnvironmentID == input.EnvironmentID && value.Generation == input.Generation &&
		value.HostID == input.HostID && value.ManifestDigest == input.ManifestDigest &&
		value.Mode == input.Mode && value.Operation == "workspace-runtime.start.v1" &&
		value.OperationID == input.OperationID && value.Profile == input.Profile &&
		value.RuntimeVersion == input.RuntimeVersion && value.SourceHead == input.Commit &&
		value.State == "ready" && value.TargetIdentityRevision == input.TargetIdentityRevision &&
		value.WorkspaceID == input.WorkspaceID && validRuntimeSessionEndpoint(value.RuntimeSessionEndpoint) &&
		value.RuntimeSessionOwnerUserID != "" && value.RuntimeSessionVersion == input.RuntimeVersion &&
		regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(value.RuntimeSessionToken) &&
		parseErr == nil && expiresAt.After(time.Now()) && expiresAt.Before(time.Now().Add(time.Hour)) &&
		containsString(value.RuntimeSessionCapabilities, "runtime.lifecycle") &&
		containsString(value.RuntimeSessionCapabilities, "runtime.heartbeat") &&
		containsString(value.RuntimeSessionRequestedCapabilities, "runtime.codex.v1")
}

func validRuntimeSessionEndpoint(value string) bool {
	endpoint, err := url.Parse(value)
	return err == nil && endpoint.Scheme == "wss" && endpoint.Host != "" &&
		endpoint.User == nil && endpoint.RawQuery == "" && endpoint.Fragment == "" &&
		endpoint.Path == "/api/workspace-runtimes/socket"
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func validLaunchResult(
	value WorkspaceRuntimeLaunchExecution,
	input WorkspaceRuntimeLaunchRequest,
) bool {
	checkedAt, err := time.Parse(time.RFC3339Nano, value.Result.CheckedAt)
	return err == nil && !checkedAt.IsZero() && value.Result.Operation == "workspace-runtime.start.v1" &&
		value.Result.OperationID == input.OperationID && value.Result.WorkspaceID == input.WorkspaceID &&
		value.Result.Generation == input.Generation && value.Result.ManifestDigest == input.ManifestDigest &&
		value.Result.SourceHead == input.Commit && value.Result.State == "running"
}

func validResult(value ExecutionResult, input StatusRequest, callerMachineID string) bool {
	checkedAt, err := time.Parse(time.RFC3339Nano, value.Result.CheckedAt)
	completedAt, completedErr := time.Parse(time.RFC3339Nano, value.Audit.CompletedAt)
	return err == nil && !checkedAt.IsZero() && completedErr == nil && !completedAt.IsZero() &&
		value.Result.SchemaVersion == APIVersion &&
		value.Result.Type == "result" && value.Result.Operation == "status.v1" &&
		value.Result.OperationID == input.OperationID && value.Result.State == "ready" &&
		revisionPattern.MatchString(value.Result.TargetIdentityRevision) &&
		value.Audit.Operation == "status.v1" &&
		value.Audit.OperationID == input.OperationID &&
		value.Audit.TargetEnvironmentID == input.EnvironmentID &&
		value.Audit.TargetIdentityRevision == value.Result.TargetIdentityRevision &&
		value.Audit.ActorKind == "machine" && value.Audit.Capability == "project_cli" &&
		value.Audit.RouteClass == "ssh_private_network" && value.Audit.Outcome == "succeeded" &&
		value.Audit.ActorID == callerMachineID && identifierPattern.MatchString(value.Audit.GatewayID) &&
		uuidPattern.MatchString(value.Audit.RouteID)
}
