package projectrun

import (
	"context"
	"io"
	"time"
)

const SchemaVersion = 1

type Capability string

const (
	CapabilityConfigured  Capability = "configured"
	CapabilityUnavailable Capability = "unavailable"
)

type State string

const (
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateStopping State = "stopping"
	StateError    State = "error"
)

type ServeResult struct {
	SchemaVersion int        `json:"schemaVersion"`
	Operation     string     `json:"operation"`
	Script        string     `json:"script"`
	Directory     string     `json:"directory"`
	Capability    Capability `json:"capability"`
	State         State      `json:"state"`
	PID           *int       `json:"pid"`
	LocalPort     *int       `json:"localPort"`
	LocalURL      *string    `json:"localUrl"`
	PublicPort    *int       `json:"publicPort"`
	PublicURL     *string    `json:"publicUrl"`
	TailscaleIPv4 *string    `json:"tailscaleIPv4"`
	AllowedHosts  []string   `json:"allowedHosts"`
	StartedAt     *string    `json:"startedAt"`
	CheckedAt     string     `json:"checkedAt"`
	LastError     *string    `json:"lastError"`
}

type RunResult struct {
	SchemaVersion int      `json:"schemaVersion"`
	Operation     string   `json:"operation"`
	Script        string   `json:"script"`
	Directory     string   `json:"directory"`
	State         string   `json:"state"`
	Command       []string `json:"command"`
	LocalPort     int      `json:"localPort"`
	LocalURL      string   `json:"localUrl"`
	StartedAt     string   `json:"startedAt"`
	FinishedAt    string   `json:"finishedAt"`
	ExitCode      *int     `json:"exitCode"`
	LastError     *string  `json:"lastError"`
}

type Command struct {
	Argv       []string
	Dir        string
	Env        []string
	InheritEnv bool
}

type ProcessRef struct {
	PID      int
	Identity string
}

type ProcessCommit func(ProcessRef) error

type Streams struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

type ProcessRunner interface {
	RunForeground(context.Context, Command, Streams, ProcessCommit) (int, error)
	StartDetached(Command, string, ProcessCommit) (ProcessRef, error)
	Alive(ProcessRef) bool
	OwnsTCP(ProcessRef, string, int) (bool, error)
	TCPPortOpen(int) (bool, error)
	StopGroup(ProcessRef, time.Duration) error
}

type Tailnet interface {
	IPv4(context.Context) (string, error)
	OccupiedTCPPorts(context.Context) (map[int]bool, error)
	MatchesTCP(context.Context, int, int) (bool, error)
	StartTCP(context.Context, int, int) error
	StopTCP(context.Context, int, int) error
}

type ProbeTarget struct {
	Host string
	Port int
	Path string
}

type Prober interface {
	Wait(context.Context, ProbeTarget, time.Duration) error
	Check(context.Context, ProbeTarget) error
}

type PortAllocator interface {
	Local(map[int]bool) (int, error)
	Public(map[int]bool) (int, error)
}

type Clock func() time.Time

type RepositoryInspector interface {
	Head(context.Context, string) (string, error)
}

type SetupState string

const (
	SetupRequired    SetupState = "required"
	SetupRunning     SetupState = "running"
	SetupReady       SetupState = "ready"
	SetupFailed      SetupState = "failed"
	SetupInterrupted SetupState = "interrupted"
	SetupStale       SetupState = "stale"
)

type SetupResult struct {
	SchemaVersion     int        `json:"schemaVersion"`
	Operation         string     `json:"operation"`
	StepID            string     `json:"stepId"`
	Directory         string     `json:"directory"`
	Capability        Capability `json:"capability"`
	State             SetupState `json:"state"`
	Commit            string     `json:"commit"`
	DeclarationDigest string     `json:"declarationDigest"`
	StartedAt         *string    `json:"startedAt"`
	FinishedAt        *string    `json:"finishedAt"`
	CheckedAt         string     `json:"checkedAt"`
	LastError         *string    `json:"lastError"`
}

type SetupCollectionResult struct {
	SchemaVersion int           `json:"schemaVersion"`
	Operation     string        `json:"operation"`
	Directory     string        `json:"directory"`
	Capability    Capability    `json:"capability"`
	Steps         []SetupResult `json:"steps"`
	CheckedAt     string        `json:"checkedAt"`
	LastError     *string       `json:"lastError"`
}

type SetupExpectations struct {
	Commit            string
	DeclarationDigest string
}

type ServerDeclarationResult struct {
	ServerID   string     `json:"serverId"`
	Label      string     `json:"label"`
	Capability Capability `json:"capability"`
}

type ServerDeclarationCollectionResult struct {
	SchemaVersion int                       `json:"schemaVersion"`
	Operation     string                    `json:"operation"`
	Directory     string                    `json:"directory"`
	Capability    Capability                `json:"capability"`
	Servers       []ServerDeclarationResult `json:"servers"`
	CheckedAt     string                    `json:"checkedAt"`
	LastError     *string                   `json:"lastError"`
}

type ServeCollectionResult struct {
	SchemaVersion int           `json:"schemaVersion"`
	Operation     string        `json:"operation"`
	CheckedAt     string        `json:"checkedAt"`
	ErrorCount    int           `json:"errorCount"`
	Sessions      []ServeResult `json:"sessions"`
}
