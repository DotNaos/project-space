package machineconnect

import (
	"context"
	"errors"
	"time"
)

var (
	ErrCredentialNotFound = errors.New("machine credential not found")
	ErrMachineKeyNotFound = errors.New("machine identity key not found")
	ErrApprovalDenied     = errors.New("machine connection was not approved")
	ErrApprovalExpired    = errors.New("machine connection approval expired")
	ErrMachineRevoked     = errors.New("machine connection was revoked")
)

type Machine struct {
	Name          string
	Hostname      string
	OS            string
	Architecture  string
	ClientVersion string
	Channel       string
	Source        string
}

type Request struct {
	ID           string
	PollToken    string
	ApprovalURL  string
	ExpiresAt    time.Time
	PollInterval time.Duration
}

type ApprovalState string

const (
	ApprovalPending  ApprovalState = "pending"
	ApprovalApproved ApprovalState = "approved"
	ApprovalDenied   ApprovalState = "denied"
	ApprovalExpired  ApprovalState = "expired"
	ApprovalConsumed ApprovalState = "consumed"
)

type Approval struct {
	State      ApprovalState
	Challenge  string
	RetryAfter time.Duration
}

type Credential struct {
	BackendURL  string    `json:"backendUrl"`
	MachineID   string    `json:"machineId"`
	MachineName string    `json:"machineName"`
	Token       string    `json:"credential"`
	IssuedAt    time.Time `json:"issuedAt"`
}

func (Credential) String() string {
	return "[redacted machine credential]"
}

func (Credential) GoString() string {
	return "machineconnect.Credential{[redacted]}"
}

type ConnectionState string

const (
	ConnectionOffline ConnectionState = "offline"
	ConnectionOnline  ConnectionState = "online"
	ConnectionRevoked ConnectionState = "revoked"
)

type Backend interface {
	Health(context.Context) error
	CreateRequest(context.Context, Machine, MachineKey) (Request, error)
	PollRequest(context.Context, Request) (Approval, error)
	Exchange(context.Context, Request, string, MachineKey) (Credential, error)
	Connection(context.Context, Credential) (ConnectionState, error)
	Revoke(context.Context, Credential) error
}

type CredentialStore interface {
	LoadKey() (MachineKey, error)
	SaveKey(MachineKey) error
	Load() (Credential, error)
	Save(Credential) error
	Delete() error
}

// CredentialLocker serializes operations that may replace or revoke the local
// machine identity. File-backed stores implement it across processes.
type CredentialLocker interface {
	Lock(context.Context) (release func() error, err error)
}

// CredentialPurger removes the complete local machine identity. Normal
// disconnects use CredentialStore.Delete so reconnecting can keep the stable
// machine key; uninstallers use Purge to remove all installation state. A
// caller must hold CredentialLocker for the same store when it is available.
type CredentialPurger interface {
	Purge() error
}

type ApprovalPresenter interface {
	Present(context.Context, string) error
}

type Connector interface {
	Start(context.Context) error
	Stop(context.Context) error
}

type ConnectorPreflighter interface {
	Preflight(context.Context) error
}

type Clock interface {
	Now() time.Time
	Sleep(context.Context, time.Duration) error
}

type RealClock struct{}

func (RealClock) Now() time.Time {
	return time.Now()
}

func (RealClock) Sleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
