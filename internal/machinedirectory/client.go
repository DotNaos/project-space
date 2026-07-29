package machinedirectory

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

const maximumResponseBytes int64 = 2 << 20

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
	tokenPattern      = regexp.MustCompile(`^[A-Za-z0-9._~+/-]+=*$`)
	errorCodePattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	statePattern      = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	uuidPattern       = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
	hostnamePattern   = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$`)
)

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
		!identifierPattern.MatchString(config.CallerMachineID) ||
		config.CredentialProvider == nil {
		return nil, ErrInvalidConfig
	}
	if baseURL.Scheme != "https" && baseURL.Hostname() != "localhost" &&
		baseURL.Hostname() != "127.0.0.1" && baseURL.Hostname() != "::1" {
		return nil, ErrInvalidConfig
	}
	httpClient := http.Client{Timeout: 10 * time.Second}
	if config.HTTPClient != nil {
		httpClient = *config.HTTPClient
		if httpClient.Timeout == 0 {
			httpClient.Timeout = 10 * time.Second
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

func (client *Client) ListMachines(ctx context.Context) (MachinesResult, error) {
	var result MachinesResult
	err := client.get(ctx, "/api/machines/catalog", nil, &result)
	if err == nil {
		err = validateMachines(&result)
	}
	return result, err
}

func (client *Client) ListThreads(ctx context.Context, filter ThreadFilter) (ThreadsResult, error) {
	query := url.Values{}
	if filter.IncludeArchived {
		query.Set("includeArchived", "true")
	}
	if filter.MachineID != "" {
		query.Set("machineId", filter.MachineID)
	}
	if filter.MachineName != "" {
		query.Set("machineName", filter.MachineName)
	}
	if filter.Search != "" {
		query.Set("search", filter.Search)
	}
	for _, state := range filter.States {
		if !statePattern.MatchString(state) {
			return ThreadsResult{}, ErrInvalidConfig
		}
		query.Add("state", state)
	}
	var result ThreadsResult
	err := client.get(ctx, "/api/codex/catalog", query, &result)
	if err == nil {
		err = validateThreads(&result)
	}
	return result, err
}

func (client *Client) ResolveSSH(ctx context.Context, machineID string) (SSHResult, error) {
	if !uuidPattern.MatchString(machineID) {
		return SSHResult{}, ErrInvalidConfig
	}
	var result SSHResult
	err := client.get(ctx, "/api/machines/catalog/"+machineID+"/ssh", nil, &result)
	if err == nil && (result.SchemaVersion != 1 || result.Machine.ID != machineID ||
		result.Machine.Name == "" || !safeHostname(result.Target)) {
		err = ErrInvalidResponse
	}
	return result, err
}

func (client *Client) get(
	ctx context.Context,
	path string,
	query url.Values,
	destination any,
) error {
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + path
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return ErrInvalidConfig
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || len(token) > 4096 || !tokenPattern.MatchString(token) {
		return ErrUnauthorized
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return decodeFailure(response)
	}
	if err := decodeBoundedJSON(response.Body, destination); err != nil {
		return ErrInvalidResponse
	}
	return nil
}

func validateMachines(result *MachinesResult) error {
	if result.SchemaVersion != 1 || result.Machines == nil || result.Failures == nil ||
		!validTime(result.CheckedAt) {
		return ErrInvalidResponse
	}
	ids := map[string]bool{}
	for _, machine := range result.Machines {
		if !uuidPattern.MatchString(machine.ID) || machine.Name == "" || ids[machine.ID] ||
			machine.Connector.Installations == nil ||
			machine.Platform.Architectures == nil || machine.Platform.OperatingSystems == nil ||
			!validSignal(machine.Tailscale, "reachable", "unreachable", "stale", "unknown", "unsupported") ||
			!validSignal(machine.SSH, "available", "unavailable", "checking", "unknown", "unsupported") ||
			!validSignal(machine.Connector.Signal, "ready", "degraded", "unavailable", "unknown") ||
			!validSignal(machine.Enrollment, "enrolled", "unknown") ||
			!validSignal(machine.CodexAppServer, "available", "unavailable", "stale", "unknown", "unsupported") {
			return ErrInvalidResponse
		}
		for _, connector := range machine.Connector.Installations {
			if connector.ID == "" || connector.Name == "" ||
				!oneOf(connector.State, "ready", "unavailable", "unknown") ||
				!validOptionalTime(connector.LastSeenAt) {
				return ErrInvalidResponse
			}
		}
		ids[machine.ID] = true
	}
	for _, failure := range result.Failures {
		if !uuidPattern.MatchString(failure.MachineID) || failure.Message == "" ||
			!oneOf(failure.Source, "identity", "probe") {
			return ErrInvalidResponse
		}
	}
	sort.Slice(result.Machines, func(i, j int) bool {
		return machineLess(result.Machines[i].Name, result.Machines[i].ID,
			result.Machines[j].Name, result.Machines[j].ID)
	})
	return nil
}

func validateThreads(result *ThreadsResult) error {
	if result.SchemaVersion != 1 || result.Hosts == nil || result.Threads == nil ||
		!validTime(result.CheckedAt) {
		return ErrInvalidResponse
	}
	for _, host := range result.Hosts {
		if !validTime(host.CheckedAt) || host.ConnectorID == "" ||
			!oneOf(host.InventoryState, "live", "stale", "unavailable") ||
			!uuidPattern.MatchString(host.MachineID) || host.MachineName == "" {
			return ErrInvalidResponse
		}
	}
	for _, thread := range result.Threads {
		if thread.ID == "" || thread.Title == "" || !uuidPattern.MatchString(thread.Machine.ID) ||
			thread.Machine.Name == "" || !validTime(thread.UpdatedAt) ||
			thread.ConnectorID == "" || !oneOf(thread.InventoryState, "live", "stale") ||
			!statePattern.MatchString(thread.State) {
			return ErrInvalidResponse
		}
	}
	sort.Slice(result.Hosts, func(i, j int) bool {
		left, right := result.Hosts[i], result.Hosts[j]
		return machineLess(left.MachineName, left.MachineID, right.MachineName, right.MachineID) ||
			left.MachineName == right.MachineName && left.MachineID == right.MachineID &&
				left.ConnectorID < right.ConnectorID
	})
	sort.Slice(result.Threads, func(i, j int) bool {
		left, right := result.Threads[i], result.Threads[j]
		leftTime, _ := time.Parse(time.RFC3339Nano, left.UpdatedAt)
		rightTime, _ := time.Parse(time.RFC3339Nano, right.UpdatedAt)
		if !leftTime.Equal(rightTime) {
			return leftTime.After(rightTime)
		}
		if comparison := compareText(left.Title, right.Title); comparison != 0 {
			return comparison < 0
		}
		if comparison := compareText(left.Machine.ID, right.Machine.ID); comparison != 0 {
			return comparison < 0
		}
		return compareText(left.ID, right.ID) < 0
	})
	return nil
}

func machineLess(leftName, leftID, rightName, rightID string) bool {
	return compareText(leftName, rightName) < 0 ||
		compareText(leftName, rightName) == 0 && compareText(leftID, rightID) < 0
}

func compareText(left, right string) int {
	leftFolded, rightFolded := strings.ToLower(left), strings.ToLower(right)
	if leftFolded < rightFolded {
		return -1
	}
	if leftFolded > rightFolded {
		return 1
	}
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}

func validTime(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func safeHostname(value string) bool {
	return len(value) > 0 && len(value) <= 253 && hostnamePattern.MatchString(value)
}

func validSignal(signal Signal, states ...string) bool {
	return oneOf(signal.State, states...) &&
		validOptionalTime(signal.CheckedAt) &&
		validOptionalTime(signal.LastSeenAt) &&
		len(signal.Message) <= 1024
}

func validOptionalTime(value string) bool {
	return value == "" || validTime(value)
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

func decodeFailure(response *http.Response) error {
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if decodeBoundedJSON(response.Body, &payload) == nil &&
		errorCodePattern.MatchString(payload.Error.Code) && len(payload.Error.Message) <= 1024 {
		return &APIError{Code: payload.Error.Code, Message: payload.Error.Message, StatusCode: response.StatusCode}
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return ErrUnauthorized
	}
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
		return ErrUnavailable
	}
	return ErrInvalidResponse
}

func decodeBoundedJSON(reader io.Reader, destination any) error {
	limited := &io.LimitedReader{R: reader, N: maximumResponseBytes + 1}
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil || limited.N == 0 {
		return ErrInvalidResponse
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return ErrInvalidResponse
	}
	return nil
}
