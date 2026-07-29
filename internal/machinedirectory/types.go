package machinedirectory

import (
	"context"
	"errors"
	"net/http"
)

var (
	ErrInvalidConfig   = errors.New("invalid machine directory client configuration")
	ErrInvalidResponse = errors.New("invalid machine directory response")
	ErrUnauthorized    = errors.New("machine directory authorization failed")
	ErrUnavailable     = errors.New("machine directory service unavailable")
)

type CredentialProvider interface {
	AccessToken(context.Context) (string, error)
}

type CredentialProviderFunc func(context.Context) (string, error)

func (provider CredentialProviderFunc) AccessToken(ctx context.Context) (string, error) {
	return provider(ctx)
}

type Signal struct {
	CheckedAt  string `json:"checkedAt,omitempty"`
	LastSeenAt string `json:"lastSeenAt,omitempty"`
	Message    string `json:"message,omitempty"`
	State      string `json:"state"`
}

type Connector struct {
	Environment string `json:"environment,omitempty"`
	ID          string `json:"id"`
	LastSeenAt  string `json:"lastSeenAt,omitempty"`
	Name        string `json:"name"`
	State       string `json:"state"`
}

type ConnectorSignal struct {
	Signal
	Installations []Connector `json:"installations"`
}

type Platform struct {
	Architectures    []string `json:"architectures"`
	OperatingSystems []string `json:"operatingSystems"`
}

type Machine struct {
	CodexAppServer Signal          `json:"codexAppServer"`
	Connector      ConnectorSignal `json:"connector"`
	Enrollment     Signal          `json:"enrollment"`
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Platform       Platform        `json:"platform"`
	SSH            Signal          `json:"ssh"`
	Tailscale      Signal          `json:"tailscale"`
}

type Failure struct {
	MachineID string `json:"machineId"`
	Message   string `json:"message"`
	Source    string `json:"source"`
}

type MachinesResult struct {
	CheckedAt     string    `json:"checkedAt"`
	Failures      []Failure `json:"failures"`
	Machines      []Machine `json:"machines"`
	SchemaVersion int       `json:"schemaVersion"`
}

type SSHResult struct {
	Machine struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"machine"`
	SchemaVersion int    `json:"schemaVersion"`
	Target        string `json:"target"`
}

type ThreadHost struct {
	CheckedAt      string `json:"checkedAt"`
	ConnectorID    string `json:"connectorId"`
	InventoryState string `json:"inventoryState"`
	MachineID      string `json:"machineId"`
	MachineName    string `json:"machineName"`
	Message        string `json:"message,omitempty"`
}

type Thread struct {
	Archived       bool   `json:"archived"`
	ConnectorID    string `json:"connectorId"`
	CWD            string `json:"cwd,omitempty"`
	ID             string `json:"id"`
	InventoryState string `json:"inventoryState"`
	Machine        struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"machine"`
	Project    string `json:"project,omitempty"`
	Repository string `json:"repository,omitempty"`
	State      string `json:"state"`
	Title      string `json:"title"`
	UpdatedAt  string `json:"updatedAt"`
}

type ThreadsResult struct {
	CheckedAt     string       `json:"checkedAt"`
	Hosts         []ThreadHost `json:"hosts"`
	Partial       bool         `json:"partial"`
	SchemaVersion int          `json:"schemaVersion"`
	Threads       []Thread     `json:"threads"`
}

type ThreadFilter struct {
	IncludeArchived bool
	MachineID       string
	MachineName     string
	Search          string
	States          []string
}

type API interface {
	ListMachines(context.Context) (MachinesResult, error)
	ListThreads(context.Context, ThreadFilter) (ThreadsResult, error)
	ResolveSSH(context.Context, string) (SSHResult, error)
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
	return "Project Space rejected the machine directory request"
}

func (failure *APIError) Unwrap() error {
	switch {
	case failure.StatusCode == http.StatusUnauthorized ||
		failure.StatusCode == http.StatusForbidden:
		return ErrUnauthorized
	case failure.StatusCode == http.StatusTooManyRequests ||
		failure.StatusCode >= http.StatusInternalServerError:
		return ErrUnavailable
	default:
		return nil
	}
}
