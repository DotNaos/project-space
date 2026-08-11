package computeinventory

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

const maximumResponseBytes int64 = 4 << 20
const inventoryV2MediaType = "application/vnd.project-space.compute-inventory+json; version=2"

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
	tokenPattern      = regexp.MustCompile(`^[A-Za-z0-9._~+/-]+=*$`)
	errorCodePattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
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
		!identifierPattern.MatchString(config.CallerMachineID) || config.CredentialProvider == nil {
		return nil, ErrInvalidConfig
	}
	if baseURL.Scheme != "https" && baseURL.Hostname() != "localhost" &&
		baseURL.Hostname() != "127.0.0.1" && baseURL.Hostname() != "::1" {
		return nil, ErrInvalidConfig
	}
	client := http.Client{Timeout: 10 * time.Second}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
		if client.Timeout == 0 {
			client.Timeout = 10 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	baseURL.Path = strings.TrimRight(baseURL.Path, "/")
	return &Client{
		baseURL: baseURL, callerMachineID: config.CallerMachineID,
		credentials: config.CredentialProvider, httpClient: &client,
	}, nil
}

func (client *Client) List(ctx context.Context) (Inventory, error) {
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + "/api/compute/inventory"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return Inventory{}, ErrInvalidConfig
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || len(token) > 4096 || !tokenPattern.MatchString(token) {
		return Inventory{}, ErrUnauthorized
	}
	request.Header.Set("Accept", inventoryV2MediaType)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return Inventory{}, ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Inventory{}, decodeFailure(response)
	}
	var inventory Inventory
	if err := decodeBoundedJSON(response.Body, &inventory); err != nil || validateInventory(&inventory) != nil {
		return Inventory{}, ErrInvalidResponse
	}
	sortInventory(&inventory)
	return inventory, nil
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
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError {
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

func validateInventory(inventory *Inventory) error {
	if !oneOfInt(inventory.SchemaVersion, 1, 2) || inventory.EnvironmentCatalog == nil ||
		inventory.EnvironmentInstances == nil || inventory.Hosts == nil ||
		inventory.Platforms == nil || inventory.Violations == nil ||
		!oneOf(inventory.InventoryState, "ready", "conflict") {
		return ErrInvalidResponse
	}
	if (inventory.SchemaVersion == 1 && inventory.PrivateNetworks != nil) ||
		(inventory.SchemaVersion == 2 && inventory.PrivateNetworks == nil) {
		return ErrInvalidResponse
	}
	if _, err := time.Parse(time.RFC3339Nano, inventory.CheckedAt); err != nil {
		return ErrInvalidResponse
	}
	if (inventory.InventoryState == "ready" && len(inventory.Violations) != 0) ||
		(inventory.InventoryState == "conflict" && len(inventory.Violations) == 0) {
		return ErrInvalidResponse
	}
	platforms := map[string]struct{}{}
	for _, platform := range inventory.Platforms {
		if !validIdentity(platform.ID) || !validText(platform.Name) || !validIdentity(platform.Alias) ||
			!oneOf(platform.Kind, "local", "github_codespaces", "cloud_sandbox", "kubernetes", "virtualization", "other") {
			return ErrInvalidResponse
		}
		if _, exists := platforms[platform.ID]; exists {
			return ErrInvalidResponse
		}
		platforms[platform.ID] = struct{}{}
	}
	definitions := map[string]struct{}{}
	for _, definition := range inventory.EnvironmentCatalog {
		if !validIdentity(definition.ID) || !validIdentity(definition.Slug) || !validText(definition.Name) ||
			definition.SupportedArchitectures == nil ||
			!oneOf(definition.Kind, environmentKinds()...) ||
			!oneOf(definition.BootstrapStrategy, "ssh", "provider_native", "workspace_runtime", "custom") ||
			!oneOf(definition.OperatingSystemFamily, "macos", "windows", "linux", "other") ||
			!oneOf(definition.Ownership, "built_in", "user_defined") {
			return ErrInvalidResponse
		}
		if _, exists := definitions[definition.ID]; exists {
			return ErrInvalidResponse
		}
		definitions[definition.ID] = struct{}{}
	}
	hosts := map[string]struct{}{}
	for _, host := range inventory.Hosts {
		if !validIdentity(host.ID) || !validIdentity(host.Alias) || !validText(host.Name) ||
			host.Capabilities.Console == nil || host.Capabilities.Power == nil ||
			!oneOf(host.Capabilities.State, "available", "unavailable", "unknown") {
			return ErrInvalidResponse
		}
		if _, exists := platforms[host.PlatformID]; !exists && inventory.InventoryState == "ready" {
			return ErrInvalidResponse
		}
		if _, exists := hosts[host.ID]; exists {
			return ErrInvalidResponse
		}
		hosts[host.ID] = struct{}{}
		if host.Resources != nil && !validResource(*host.Resources) {
			return ErrInvalidResponse
		}
		if (inventory.SchemaVersion == 1 && host.AccessRoutes != nil) ||
			!validAccessRoutes(host.AccessRoutes, inventory.SchemaVersion) {
			return ErrInvalidResponse
		}
	}
	instances := map[string]struct{}{}
	references := map[string]struct{}{}
	for _, instance := range inventory.EnvironmentInstances {
		if !validIdentity(instance.ID) || !validIdentity(instance.Alias) || !validText(instance.Name) ||
			!validReference(instance.Reference) || instance.AccessRoutes == nil || instance.Workspaces == nil ||
			!oneOf(instance.WorkspaceInventory.State, "available", "unavailable") ||
			!oneOf(instance.Hostd.State, "available", "unavailable", "unknown") ||
			instance.ProviderLifecycleState != "unknown" ||
			!oneOf(instance.Kind, environmentKinds()...) ||
			!oneOf(instance.HostResolution, "verified", "manual", "unresolved", "conflict", "not_applicable") ||
			!oneOf(instance.ResourceMode, "dedicated", "shared", "exclusive") {
			return ErrInvalidResponse
		}
		if _, exists := definitions[instance.EnvironmentDefinitionID]; !exists && inventory.InventoryState == "ready" {
			return ErrInvalidResponse
		}
		if _, exists := platforms[instance.PlatformID]; !exists && inventory.InventoryState == "ready" {
			return ErrInvalidResponse
		}
		if instance.HostID != "" {
			if _, exists := hosts[instance.HostID]; !exists && inventory.InventoryState == "ready" {
				return ErrInvalidResponse
			}
		}
		if _, exists := instances[instance.ID]; exists {
			return ErrInvalidResponse
		}
		if _, exists := references[instance.Reference]; exists {
			return ErrInvalidResponse
		}
		instances[instance.ID] = struct{}{}
		references[instance.Reference] = struct{}{}
		if instance.Resources != nil && !validResource(*instance.Resources) {
			return ErrInvalidResponse
		}
		if !validAccessRoutes(instance.AccessRoutes, inventory.SchemaVersion) {
			return ErrInvalidResponse
		}
	}
	for _, instance := range inventory.EnvironmentInstances {
		if instance.ParentEnvironmentInstanceID != "" {
			if _, exists := instances[instance.ParentEnvironmentInstanceID]; !exists && inventory.InventoryState == "ready" {
				return ErrInvalidResponse
			}
		}
	}
	for _, network := range inventory.PrivateNetworks {
		if !validIdentity(network.ID) || !validText(network.Name) ||
			!oneOf(network.ProviderKind, "tailscale", "wireguard", "other") ||
			!oneOf(network.ApprovalState, "approved", "pending", "revoked") ||
			!oneOf(network.State, "available", "unavailable", "unknown") ||
			!validOptionalTime(network.LastVerifiedAt) {
			return ErrInvalidResponse
		}
	}
	return nil
}

func validAccessRoutes(routes []AccessRoute, schemaVersion int) bool {
	for _, route := range routes {
		if route.Capabilities == nil {
			return false
		}
		if route.Type == "connector" {
			if !oneOf(route.ConnectorStatus, "local", "online", "offline", "not-installed") ||
				route.Available == nil ||
				route.ID != "" || route.LastVerifiedAt != "" || route.Priority != 0 ||
				route.ProviderKind != "" || route.State != "" || !validOptionalTime(route.LastSeen) {
				return false
			}
			continue
		}
		if schemaVersion != 2 || route.Available != nil || !validIdentity(route.ID) || route.ConnectorStatus != "" ||
			route.LastSeen != "" || route.Priority < 0 || route.Priority > 1000 ||
			!oneOf(route.Type, "ssh_private_network", "provider_native", "host_console", "hostd") ||
			!oneOf(route.State, "ready", "unavailable", "unverified", "stale", "policy_blocked") ||
			!validControlledCapabilities(route.Type, route.Capabilities) ||
			(route.ProviderKind != "" && !oneOf(route.ProviderKind, "tailscale", "wireguard", "other")) ||
			(route.Type == "ssh_private_network" && route.ProviderKind == "") ||
			!validOptionalTime(route.LastVerifiedAt) {
			return false
		}
	}
	return true
}

func validControlledCapabilities(routeType string, capabilities []string) bool {
	allowed := map[string][]string{
		"ssh_private_network": {"project_cli", "interactive_shell"},
		"provider_native":     {"project_cli", "interactive_shell", "provider_exec"},
		"host_console":        {"host_console", "host_power"},
		"hostd":               {"hostd_telemetry"},
	}[routeType]
	for _, capability := range capabilities {
		if !oneOf(capability, allowed...) {
			return false
		}
	}
	return len(capabilities) > 0
}

func validOptionalTime(value string) bool {
	if value == "" {
		return true
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func validResource(resource ResourceSummary) bool {
	if resource.Architecture == "" || resource.OperatingSystem == "" ||
		resource.CPUCores < 0 || resource.MemoryTotalBytes < 0 || resource.StorageTotalBytes < 0 ||
		!oneOf(resource.Source, "connector", "provider", "configured") {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, resource.ReportedAt)
	return err == nil
}

func validIdentity(value string) bool { return identifierPattern.MatchString(value) }
func validText(value string) bool {
	return strings.TrimSpace(value) == value && value != "" && len(value) <= 255
}
func validReference(value string) bool { return validIdentity(value) && strings.Count(value, "/") == 2 }
func oneOf(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if value == candidate {
			return true
		}
	}
	return false
}

func oneOfInt(value int, candidates ...int) bool {
	for _, candidate := range candidates {
		if value == candidate {
			return true
		}
	}
	return false
}

func environmentKinds() []string {
	return []string{
		"native_macos", "native_windows", "native_linux", "wsl", "docker", "devbox",
		"github_codespace", "cloud_sandbox", "kubernetes_workload", "virtual_machine", "other",
	}
}

func sortInventory(inventory *Inventory) {
	sort.Slice(inventory.EnvironmentCatalog, func(i, j int) bool {
		return inventory.EnvironmentCatalog[i].Slug < inventory.EnvironmentCatalog[j].Slug
	})
	sort.Slice(inventory.Platforms, func(i, j int) bool {
		return inventory.Platforms[i].Name < inventory.Platforms[j].Name
	})
	sort.Slice(inventory.Hosts, func(i, j int) bool {
		return inventory.Hosts[i].Name < inventory.Hosts[j].Name
	})
	sort.Slice(inventory.EnvironmentInstances, func(i, j int) bool {
		return inventory.EnvironmentInstances[i].Reference < inventory.EnvironmentInstances[j].Reference
	})
	sort.Slice(inventory.PrivateNetworks, func(i, j int) bool {
		if inventory.PrivateNetworks[i].Name == inventory.PrivateNetworks[j].Name {
			return inventory.PrivateNetworks[i].ID < inventory.PrivateNetworks[j].ID
		}
		return inventory.PrivateNetworks[i].Name < inventory.PrivateNetworks[j].Name
	})
}
