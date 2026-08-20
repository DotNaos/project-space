package computeinventory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

var (
	ErrInvalidConfig   = errors.New("invalid compute inventory client configuration")
	ErrInvalidResponse = errors.New("invalid compute inventory response")
	ErrUnauthorized    = errors.New("compute inventory authorization failed")
	ErrUnavailable     = errors.New("compute inventory service unavailable")
)

type CredentialProvider interface {
	AccessToken(context.Context) (string, error)
}

type CredentialProviderFunc func(context.Context) (string, error)

func (provider CredentialProviderFunc) AccessToken(ctx context.Context) (string, error) {
	return provider(ctx)
}

type ResourceSummary struct {
	Architecture          string   `json:"architecture"`
	CPUCores              float64  `json:"cpuCores"`
	CPULimit              *float64 `json:"cpuLimit,omitempty"`
	CPUUsedPercent        *float64 `json:"cpuUsedPercent,omitempty"`
	GPU                   []GPU    `json:"gpu,omitempty"`
	MemoryAvailableBytes  *float64 `json:"memoryAvailableBytes,omitempty"`
	MemoryLimitBytes      *float64 `json:"memoryLimitBytes,omitempty"`
	MemoryTotalBytes      float64  `json:"memoryTotalBytes"`
	OperatingSystem       string   `json:"operatingSystem"`
	ReportedAt            string   `json:"reportedAt"`
	Source                string   `json:"source"`
	StorageAvailableBytes *float64 `json:"storageAvailableBytes,omitempty"`
	StorageTotalBytes     float64  `json:"storageTotalBytes"`
}

type GPU struct {
	MemoryBytes *float64 `json:"memoryBytes,omitempty"`
	Model       string   `json:"model"`
	UsedPercent *float64 `json:"usedPercent,omitempty"`
}

type EnvironmentDefinition struct {
	BootstrapStrategy      string   `json:"bootstrapStrategy"`
	ID                     string   `json:"id"`
	Kind                   string   `json:"kind"`
	Name                   string   `json:"name"`
	OperatingSystemFamily  string   `json:"operatingSystemFamily"`
	Ownership              string   `json:"ownership"`
	Slug                   string   `json:"slug"`
	SupportedArchitectures []string `json:"supportedArchitectures"`
}

type Platform struct {
	Alias string `json:"alias"`
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Name  string `json:"name"`
}

type HostCapabilities struct {
	Console []string               `json:"console"`
	Power   []string               `json:"power"`
	State   string                 `json:"state"`
	Summary *HostCapabilitySummary `json:"summary,omitempty"`
}

type HostCapabilitySummary struct {
	Console   string `json:"console"`
	Power     string `json:"power"`
	Provider  string `json:"provider"`
	Reset     string `json:"reset"`
	WakeOnLan string `json:"wakeOnLan"`
}

type Host struct {
	AccessRoutes []AccessRoute    `json:"accessRoutes,omitempty"`
	Alias        string           `json:"alias"`
	Capabilities HostCapabilities `json:"capabilities"`
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	PlatformID   string           `json:"platformId"`
	Resources    *ResourceSummary `json:"resources,omitempty"`
}

type AccessRoute struct {
	Available       *bool         `json:"available,omitempty"`
	Capabilities    []string      `json:"capabilities"`
	ClientAccess    *ClientAccess `json:"clientAccess,omitempty"`
	ConnectorStatus string        `json:"connectorStatus"`
	ID              string        `json:"id,omitempty"`
	LastSeen        string        `json:"lastSeen,omitempty"`
	LastVerifiedAt  string        `json:"lastVerifiedAt,omitempty"`
	Priority        int           `json:"priority,omitempty"`
	ProviderKind    string        `json:"providerKind,omitempty"`
	State           string        `json:"state,omitempty"`
	Type            string        `json:"type"`
}

// ClientAccess contains only the target metadata a local client needs to
// launch its own verified SSH process. It deliberately excludes credentials,
// agent sockets, commands, and terminal data.
type ClientAccess struct {
	Address                string `json:"address"`
	HostKeySHA256          string `json:"hostKeySha256"`
	Port                   int    `json:"port"`
	TargetIdentityRevision string `json:"targetIdentityRevision"`
	User                   string `json:"user"`
}

func (route AccessRoute) MarshalJSON() ([]byte, error) {
	if route.Type == "connector" {
		available := false
		if route.Available != nil {
			available = *route.Available
		}
		return json.Marshal(struct {
			Available       bool     `json:"available"`
			Capabilities    []string `json:"capabilities"`
			ConnectorStatus string   `json:"connectorStatus"`
			LastSeen        string   `json:"lastSeen,omitempty"`
			Type            string   `json:"type"`
		}{available, route.Capabilities, route.ConnectorStatus, route.LastSeen, route.Type})
	}
	if !oneOf(route.Type, "ssh_private_network", "provider_native", "host_console", "hostd") {
		return nil, fmt.Errorf("cannot encode unknown access route type %q", route.Type)
	}
	return json.Marshal(struct {
		Capabilities   []string      `json:"capabilities"`
		ClientAccess   *ClientAccess `json:"clientAccess,omitempty"`
		ID             string        `json:"id"`
		LastVerifiedAt string        `json:"lastVerifiedAt,omitempty"`
		Priority       int           `json:"priority"`
		ProviderKind   string        `json:"providerKind,omitempty"`
		State          string        `json:"state"`
		Type           string        `json:"type"`
	}{route.Capabilities, route.ClientAccess, route.ID, route.LastVerifiedAt, route.Priority,
		route.ProviderKind, route.State, route.Type})
}

type PrivateNetwork struct {
	ApprovalState  string `json:"approvalState"`
	ID             string `json:"id"`
	LastVerifiedAt string `json:"lastVerifiedAt,omitempty"`
	Name           string `json:"name"`
	ProviderKind   string `json:"providerKind"`
	State          string `json:"state"`
}

type WorkspaceSummary struct {
	ID         string                   `json:"id"`
	Name       string                   `json:"name"`
	Repository string                   `json:"repository,omitempty"`
	Runtime    *WorkspaceRuntimeSummary `json:"runtime,omitempty"`
	State      string                   `json:"state"`
}

type WorkspaceRuntimeSummary struct {
	Codex      string             `json:"codex"`
	Connection string             `json:"connection"`
	DevServers []DevServerSummary `json:"devServers"`
	Evidence   string             `json:"evidence"`
	Lifecycle  string             `json:"lifecycle"`
}

type DevServerSummary struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

type EnvironmentAccessSummary struct {
	ProviderKind string           `json:"providerKind"`
	Route        string           `json:"route"`
	SSH          SSHAccessSummary `json:"ssh"`
}

type SSHAccessSummary struct {
	HostKey    string `json:"hostKey"`
	ProjectCLI string `json:"projectCli"`
	Readiness  string `json:"readiness"`
}

type EnvironmentInstance struct {
	AccessRoutes                []AccessRoute             `json:"accessRoutes"`
	AccessSummary               *EnvironmentAccessSummary `json:"accessSummary,omitempty"`
	Alias                       string                    `json:"alias"`
	EnvironmentDefinitionID     string                    `json:"environmentDefinitionId"`
	HostID                      string                    `json:"hostId,omitempty"`
	HostResolution              string                    `json:"hostResolution"`
	Hostd                       HostdAvailability         `json:"hostd"`
	ID                          string                    `json:"id"`
	Kind                        string                    `json:"kind"`
	Name                        string                    `json:"name"`
	ParentEnvironmentInstanceID string                    `json:"parentEnvironmentInstanceId,omitempty"`
	PlatformID                  string                    `json:"platformId"`
	ProviderLifecycleState      string                    `json:"providerLifecycleState"`
	Reference                   string                    `json:"reference"`
	ResourceMode                string                    `json:"resourceMode"`
	Resources                   *ResourceSummary          `json:"resources,omitempty"`
	WorkspaceInventory          InventoryAvailability     `json:"workspaceInventory"`
	Workspaces                  []WorkspaceSummary        `json:"workspaces"`
}

type HostdAvailability struct {
	Health          string   `json:"health,omitempty"`
	HostdVersion    string   `json:"hostdVersion,omitempty"`
	LastSeenAt      string   `json:"lastSeenAt,omitempty"`
	ObservedAt      string   `json:"observedAt,omitempty"`
	PartialMetrics  []string `json:"partialMetrics,omitempty"`
	ProtocolVersion *int     `json:"protocolVersion,omitempty"`
	State           string   `json:"state"`
}

func (hostd HostdAvailability) MarshalJSON() ([]byte, error) {
	if hostd.State == "available" || hostd.State == "stale" {
		return json.Marshal(struct {
			Health          string   `json:"health"`
			HostdVersion    string   `json:"hostdVersion"`
			LastSeenAt      string   `json:"lastSeenAt"`
			ObservedAt      string   `json:"observedAt"`
			PartialMetrics  []string `json:"partialMetrics"`
			ProtocolVersion *int     `json:"protocolVersion"`
			State           string   `json:"state"`
		}{hostd.Health, hostd.HostdVersion, hostd.LastSeenAt, hostd.ObservedAt,
			hostd.PartialMetrics, hostd.ProtocolVersion, hostd.State})
	}
	return json.Marshal(struct {
		State string `json:"state"`
	}{hostd.State})
}

type InventoryAvailability struct {
	State string `json:"state"`
}

type Violation struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Inventory struct {
	CheckedAt            string                  `json:"checkedAt"`
	EnvironmentCatalog   []EnvironmentDefinition `json:"environmentCatalog"`
	EnvironmentInstances []EnvironmentInstance   `json:"environmentInstances"`
	Hosts                []Host                  `json:"hosts"`
	InventoryState       string                  `json:"inventoryState"`
	Platforms            []Platform              `json:"platforms"`
	PrivateNetworks      []PrivateNetwork        `json:"privateNetworks,omitempty"`
	SchemaVersion        int                     `json:"schemaVersion"`
	Violations           []Violation             `json:"violations"`
}

func (inventory Inventory) MarshalJSON() ([]byte, error) {
	type wireInventory Inventory
	encoded, err := json.Marshal(wireInventory(inventory))
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	if inventory.SchemaVersion == 1 {
		delete(fields, "privateNetworks")
	} else if inventory.SchemaVersion == 2 || inventory.SchemaVersion == 3 {
		if _, exists := fields["privateNetworks"]; !exists {
			fields["privateNetworks"] = json.RawMessage(`[]`)
		}
	}
	return json.Marshal(fields)
}

type API interface {
	List(context.Context) (Inventory, error)
}

type APIError struct {
	Code       string
	Message    string
	StatusCode int
}

func (failure *APIError) Error() string {
	if failure.Message != "" {
		return failure.Message
	}
	return "Project Space rejected the compute inventory request"
}

func (failure *APIError) Unwrap() error {
	switch {
	case failure.StatusCode == http.StatusUnauthorized || failure.StatusCode == http.StatusForbidden:
		return ErrUnauthorized
	case failure.StatusCode == http.StatusTooManyRequests || failure.StatusCode >= http.StatusInternalServerError:
		return ErrUnavailable
	default:
		return nil
	}
}
