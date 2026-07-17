package machineconnect

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type ConnectorProfileChannel string

const (
	ConnectorProfileChannelStable ConnectorProfileChannel = "stable"
	ConnectorProfileChannelBeta   ConnectorProfileChannel = "beta"
	ConnectorProfileChannelDev    ConnectorProfileChannel = "dev"

	DevelopmentConnectorProfileName = "dev"
	DevelopmentConnectorSource      = "source"
)

type ConnectorProfile struct {
	Name                       string
	Channel                    ConnectorProfileChannel
	Source                     string
	StateRoot                  string
	CredentialPath             string
	CodexOperationSnapshotPath string
	ReadinessPath              string
	PIDPath                    string
	LogPath                    string
	LauncherPath               string
	RuntimeLockPath            string
}

func NewDevelopmentConnectorProfile(configRoot string) (ConnectorProfile, error) {
	root := strings.TrimSpace(configRoot)
	if root == "" {
		resolved, err := os.UserConfigDir()
		if err != nil {
			return ConnectorProfile{}, fmt.Errorf("resolve development connector config directory: %w", err)
		}
		root = resolved
	}
	if strings.ContainsRune(root, '\x00') {
		return ConnectorProfile{}, errors.New("development connector config directory is invalid")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return ConnectorProfile{}, fmt.Errorf("resolve development connector config directory: %w", err)
	}
	stateRoot := filepath.Join(absoluteRoot, "project-space", "profiles", DevelopmentConnectorProfileName)
	profile := ConnectorProfile{
		Name:                       DevelopmentConnectorProfileName,
		Channel:                    ConnectorProfileChannelDev,
		Source:                     DevelopmentConnectorSource,
		StateRoot:                  stateRoot,
		CredentialPath:             filepath.Join(stateRoot, "machine-credential.json"),
		CodexOperationSnapshotPath: filepath.Join(stateRoot, CodexOperationSnapshotFilename),
		ReadinessPath:              filepath.Join(stateRoot, connectorRuntimeReadyName),
		PIDPath:                    filepath.Join(stateRoot, "connector.pid"),
		LogPath:                    filepath.Join(stateRoot, "connector.log"),
		LauncherPath:               filepath.Join(stateRoot, "source-launcher.sh"),
		RuntimeLockPath:            filepath.Join(stateRoot, "connector.runtime.lock"),
	}
	if err := ValidateConnectorProfile(profile); err != nil {
		return ConnectorProfile{}, err
	}
	return profile, nil
}

func ValidateConnectorProfile(profile ConnectorProfile) error {
	if profile.Name != DevelopmentConnectorProfileName ||
		profile.Channel != ConnectorProfileChannelDev ||
		profile.Source != DevelopmentConnectorSource {
		return errors.New("development connector profile metadata is invalid")
	}
	if !filepath.IsAbs(profile.StateRoot) || filepath.Clean(profile.StateRoot) != profile.StateRoot {
		return errors.New("development connector profile state root is invalid")
	}
	for label, candidate := range map[string]struct {
		actual   string
		expected string
	}{
		"credential":               {profile.CredentialPath, filepath.Join(profile.StateRoot, "machine-credential.json")},
		"Codex operation snapshot": {profile.CodexOperationSnapshotPath, filepath.Join(profile.StateRoot, CodexOperationSnapshotFilename)},
		"readiness":                {profile.ReadinessPath, filepath.Join(profile.StateRoot, connectorRuntimeReadyName)},
		"pid":                      {profile.PIDPath, filepath.Join(profile.StateRoot, "connector.pid")},
		"log":                      {profile.LogPath, filepath.Join(profile.StateRoot, "connector.log")},
		"launcher":                 {profile.LauncherPath, filepath.Join(profile.StateRoot, "source-launcher.sh")},
		"runtime lock":             {profile.RuntimeLockPath, filepath.Join(profile.StateRoot, "connector.runtime.lock")},
	} {
		if candidate.actual != candidate.expected {
			return fmt.Errorf("development connector profile %s path is invalid", label)
		}
	}
	return nil
}

func (profile ConnectorProfile) NewCredentialStore() (CredentialStore, error) {
	if err := ValidateConnectorProfile(profile); err != nil {
		return nil, err
	}
	return newDevelopmentConnectorCredentialStore(profile)
}
