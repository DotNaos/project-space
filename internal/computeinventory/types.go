package computeinventory

import (
	"context"
	"errors"
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
	MemoryAvailableBytes  *float64 `json:"memoryAvailableBytes,omitempty"`
	MemoryLimitBytes      *float64 `json:"memoryLimitBytes,omitempty"`
	MemoryTotalBytes      float64  `json:"memoryTotalBytes"`
	OperatingSystem       string   `json:"operatingSystem"`
	ReportedAt            string   `json:"reportedAt"`
	Source                string   `json:"source"`
	StorageAvailableBytes *float64 `json:"storageAvailableBytes,omitempty"`
	StorageTotalBytes     float64  `json:"storageTotalBytes"`
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
	Console []string `json:"console"`
	Power   []string `json:"power"`
	State   string   `json:"state"`
}

type Host struct {
	Alias        string           `json:"alias"`
	Capabilities HostCapabilities `json:"capabilities"`
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	PlatformID   string           `json:"platformId"`
	Resources    *ResourceSummary `json:"resources,omitempty"`
}

type AccessRoute struct {
	Available       bool     `json:"available"`
	Capabilities    []string `json:"capabilities"`
	ConnectorStatus string   `json:"connectorStatus"`
	LastSeen        string   `json:"lastSeen,omitempty"`
	Type            string   `json:"type"`
}

type WorkspaceSummary struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Repository string `json:"repository,omitempty"`
	State      string `json:"state"`
}

type EnvironmentInstance struct {
	AccessRoutes                []AccessRoute         `json:"accessRoutes"`
	Alias                       string                `json:"alias"`
	EnvironmentDefinitionID     string                `json:"environmentDefinitionId"`
	HostID                      string                `json:"hostId,omitempty"`
	HostResolution              string                `json:"hostResolution"`
	Hostd                       HostdAvailability     `json:"hostd"`
	ID                          string                `json:"id"`
	Kind                        string                `json:"kind"`
	Name                        string                `json:"name"`
	ParentEnvironmentInstanceID string                `json:"parentEnvironmentInstanceId,omitempty"`
	PlatformID                  string                `json:"platformId"`
	ProviderLifecycleState      string                `json:"providerLifecycleState"`
	Reference                   string                `json:"reference"`
	ResourceMode                string                `json:"resourceMode"`
	Resources                   *ResourceSummary      `json:"resources,omitempty"`
	WorkspaceInventory          InventoryAvailability `json:"workspaceInventory"`
	Workspaces                  []WorkspaceSummary    `json:"workspaces"`
}

type HostdAvailability struct {
	State string `json:"state"`
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
	SchemaVersion        int                     `json:"schemaVersion"`
	Violations           []Violation             `json:"violations"`
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
