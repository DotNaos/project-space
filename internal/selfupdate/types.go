package selfupdate

import (
	"context"
	"io"
)

type InstallSource string

const (
	InstallSourceManaged        InstallSource = "managed"
	InstallSourceHomebrew       InstallSource = "homebrew"
	InstallSourceWindows        InstallSource = "windows-installer"
	InstallSourceSourceCheckout InstallSource = "source-checkout"
	InstallSourceUnknown        InstallSource = "unknown"
)

type State string

const (
	StateCurrent            State = "current"
	StateUpdateAvailable    State = "update-available"
	StateUnsupportedSource  State = "unsupported-source"
	StateVerificationFailed State = "verification-failed"
	StateUpdateFailed       State = "update-failed"
	StateRolledBack         State = "rolled-back"
	StateUpdated            State = "updated"
)

type Result struct {
	ActionableBlocker string        `json:"actionableBlocker,omitempty"`
	CurrentVersion    string        `json:"currentVersion"`
	InstallSource     InstallSource `json:"installSource"`
	State             State         `json:"state"`
	TargetVersion     string        `json:"targetVersion"`
}

type BundleVersions struct {
	Connector    string `json:"connector"`
	MachineTools string `json:"machineTools"`
	ProjectCLI   string `json:"projectCli"`
}

type Artifact struct {
	AssetName       string         `json:"assetName"`
	BundleVersions  BundleVersions `json:"bundleVersions"`
	Capabilities    []string       `json:"capabilities"`
	DownloadURL     string         `json:"downloadUrl"`
	ProtocolVersion string         `json:"protocolVersion"`
	SHA256          string         `json:"sha256"`
	SizeBytes       int64          `json:"sizeBytes"`
	Target          string         `json:"target"`
}

type Manifest struct {
	Artifacts []Artifact `json:"artifacts"`
	BuildID   string     `json:"buildId"`
	Channel   string     `json:"channel"`
	ExpiresAt string     `json:"expiresAt"`
	IssuedAt  string     `json:"issuedAt"`
	ReleaseID string     `json:"releaseId"`
	Schema    string     `json:"schema"`
	Source    string     `json:"source"`
	Version   string     `json:"version"`
}

type SignedManifest struct {
	Manifest  Manifest `json:"manifest"`
	Signature string   `json:"signature"`
}

type Release struct {
	Artifact Artifact
	Manifest Manifest
}

type Installation struct {
	CurrentVersion string
	ExecutablePath string
	InstallDir     string
	Source         InstallSource
	Target         string
}

type Plan struct {
	Installation Installation
	Release      Release
	Result       Result
}

type ReleaseResolver interface {
	Resolve(context.Context, string) (Release, error)
}

type InstallDetector interface {
	Detect() (Installation, error)
}

type ApplyOutcome string

const (
	ApplyOutcomeUpdated          ApplyOutcome = "updated"
	ApplyOutcomeRolledBack       ApplyOutcome = "rolled-back"
	ApplyOutcomeRecoveryRequired ApplyOutcome = "recovery-required"
)

type ArtifactInstaller interface {
	Apply(
		context.Context,
		Installation,
		Release,
		io.Writer,
		io.Writer,
	) (ApplyOutcome, error)
}
