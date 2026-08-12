package workspacerun

import (
	"context"
	"io"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

const (
	SchemaVersion            = 1
	SupportedProjectProtocol = 1
)

type Mode string

const (
	ModeProcess      Mode = "process"
	ModeDevcontainer Mode = "devcontainer"
)

type CredentialScope string

const CredentialScopeWorkspaceGeneration CredentialScope = "workspace-generation"

type RuntimeState string

const (
	StateStarting   RuntimeState = "starting"
	StateRunning    RuntimeState = "running"
	StateSuspending RuntimeState = "suspending"
	StateSuspended  RuntimeState = "suspended"
	StateResuming   RuntimeState = "resuming"
	StateStopping   RuntimeState = "stopping"
	StateStopped    RuntimeState = "stopped"
	StateCleaning   RuntimeState = "cleaning"
	StateStale      RuntimeState = "stale"
	StateFailed     RuntimeState = "failed"
)

type Disposition string

const (
	DispositionCreated Disposition = "created"
	DispositionReused  Disposition = "reused"
	DispositionCleaned Disposition = "cleaned"
)

type ToolID string

const (
	ToolProject ToolID = "project"
	ToolCodex   ToolID = "codex"
	ToolBun     ToolID = "bun"
	ToolNode    ToolID = "node"
	ToolGo      ToolID = "go"
	ToolPython  ToolID = "python"
	ToolRust    ToolID = "rust"
)

type ResourceLimits struct {
	CPUMillis int `json:"cpuMillis" yaml:"cpuMillis"`
	MemoryMiB int `json:"memoryMiB" yaml:"memoryMiB"`
	PIDs      int `json:"pids" yaml:"pids"`
}

func (limits ResourceLimits) Empty() bool {
	return limits.CPUMillis == 0 && limits.MemoryMiB == 0 && limits.PIDs == 0
}

type ToolPin struct {
	ID      ToolID `json:"id" yaml:"id"`
	Version string `json:"version" yaml:"version"`
	SHA256  string `json:"sha256" yaml:"sha256"`
}

type PortDeclaration struct {
	ID        string `json:"id" yaml:"id"`
	DevServer string `json:"devServer" yaml:"devServer"`
	Protocol  string `json:"protocol" yaml:"protocol"`
}

type DevcontainerDeclaration struct {
	Path string `json:"path" yaml:"path"`
}

type Manifest struct {
	Version         int                      `json:"version" yaml:"version"`
	DefaultMode     Mode                     `json:"defaultMode" yaml:"defaultMode"`
	CredentialScope CredentialScope          `json:"credentialScope" yaml:"credentialScope"`
	ProjectProtocol int                      `json:"projectProtocol" yaml:"projectProtocol"`
	ProjectRuntime  ToolPin                  `json:"projectRuntime" yaml:"projectRuntime"`
	Codex           ToolPin                  `json:"codex" yaml:"codex"`
	Toolchains      []ToolPin                `json:"toolchains" yaml:"toolchains"`
	Inputs          []string                 `json:"inputs" yaml:"inputs"`
	Setup           []string                 `json:"setup" yaml:"setup"`
	Startup         []string                 `json:"startup" yaml:"startup"`
	Shutdown        []string                 `json:"shutdown" yaml:"shutdown"`
	DevServers      []string                 `json:"devServers" yaml:"devServers"`
	Ports           []PortDeclaration        `json:"ports" yaml:"ports"`
	Resources       ResourceLimits           `json:"resources" yaml:"resources"`
	Devcontainer    *DevcontainerDeclaration `json:"devcontainer,omitempty" yaml:"devcontainer,omitempty"`
}

type ManifestResolution struct {
	Directory string   `json:"directory"`
	Path      string   `json:"path"`
	Digest    string   `json:"digest"`
	Manifest  Manifest `json:"manifest"`
}

type WorkspaceIdentity struct {
	WorkspaceID   string `json:"workspaceId"`
	Repository    string `json:"repository"`
	Directory     string `json:"directory"`
	GitDirectory  string `json:"gitDirectory"`
	IdentityProof string `json:"-"`
	Branch        string `json:"branch"`
	Head          string `json:"head"`
	Dirty         bool   `json:"dirty"`
	Owner         string `json:"-"`
}

type ResourceKind string

const (
	ResourceProcess   ResourceKind = "process"
	ResourceContainer ResourceKind = "container"
)

type RuntimeBinding struct {
	WorkspaceID    string `json:"workspaceId"`
	Generation     string `json:"generation"`
	ManifestDigest string `json:"manifestDigest"`
	OwnershipToken string `json:"ownershipToken"`
}

type ProcessHandle struct {
	PID           int    `json:"pid"`
	Identity      string `json:"processIdentity"`
	BindingDigest string `json:"bindingDigest"`
}

type ContainerHandle struct {
	Provider    string         `json:"provider"`
	ContainerID string         `json:"containerId"`
	ImageDigest string         `json:"imageDigest"`
	Binding     RuntimeBinding `json:"binding"`
}

type RuntimeHandle struct {
	Kind      ResourceKind     `json:"kind"`
	Process   *ProcessHandle   `json:"process,omitempty"`
	Container *ContainerHandle `json:"container,omitempty"`
}

type ProviderObservation struct {
	Exists    bool
	Owned     bool
	Running   bool
	Suspended bool
	Handle    RuntimeHandle
}

type LaunchRequest struct {
	Workspace      WorkspaceIdentity
	Binding        RuntimeBinding
	Directory      string
	Manifest       Manifest
	LogPath        string
	GenerationHome string
	ProjectBinary  string
	Commit         func(RuntimeHandle) error
}

type RuntimeProvider interface {
	Mode() Mode
	Start(context.Context, LaunchRequest) (RuntimeHandle, error)
	Inspect(context.Context, RuntimeHandle, RuntimeBinding) (ProviderObservation, error)
	Suspend(context.Context, RuntimeHandle, RuntimeBinding) error
	Resume(context.Context, RuntimeHandle, RuntimeBinding) error
	Stop(context.Context, RuntimeHandle, RuntimeBinding, time.Duration) error
	Clean(context.Context, RuntimeHandle, RuntimeBinding) error
}

type ProjectLifecycle interface {
	PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error)
	RunWithOptions(context.Context, string, string, projectrun.Streams, projectrun.RunOptions) (projectrun.RunResult, error)
	StartWithOptions(context.Context, string, string, projectrun.StartOptions) (projectrun.ServeResult, error)
	Status(context.Context, string, string) (projectrun.ServeResult, error)
	StopExpected(context.Context, string, string, string, string) (projectrun.ServeResult, error)
}

type VerifiedTools struct {
	ProjectBinary string
}

type ToolVerifier interface {
	Verify(context.Context, Manifest) (VerifiedTools, error)
}

type IdentityResolver interface {
	Resolve(context.Context, string) (WorkspaceIdentity, error)
}

type OperationOptions struct {
	Mode                Mode
	ExpectedWorkspaceID string
	ExpectedCommit      string
	ExpectedDigest      string
	ExpectedGeneration  string
	ThreadID            string
	TrustedGateway      bool
}

type Clock func() time.Time
type Token func() (string, error)

type Streams struct {
	Out io.Writer
	Err io.Writer
}

type ManagedDevServer struct {
	Name        string  `json:"name"`
	ServerID    string  `json:"serverId"`
	TmuxSession string  `json:"tmuxSession"`
	State       string  `json:"state"`
	LocalPort   *int    `json:"localPort"`
	LocalURL    *string `json:"localUrl"`
}

type Result struct {
	SchemaVersion  int                `json:"schemaVersion"`
	Operation      string             `json:"operation"`
	Disposition    Disposition        `json:"disposition,omitempty"`
	WorkspaceID    string             `json:"workspaceId"`
	Generation     string             `json:"generation,omitempty"`
	Directory      string             `json:"directory"`
	Repository     string             `json:"repository"`
	ManifestDigest string             `json:"manifestDigest"`
	SourceHead     string             `json:"sourceHead"`
	Mode           Mode               `json:"mode"`
	State          RuntimeState       `json:"state"`
	PID            *int               `json:"pid"`
	Resources      ResourceLimits     `json:"resources"`
	DevServers     []ManagedDevServer `json:"devServers"`
	StartedAt      *string            `json:"startedAt,omitempty"`
	CheckedAt      string             `json:"checkedAt"`
	LastError      *string            `json:"lastError,omitempty"`
}
