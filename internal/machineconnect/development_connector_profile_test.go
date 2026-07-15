package machineconnect

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDevelopmentConnectorProfileUsesExplicitIsolatedMetadataAndPaths(t *testing.T) {
	configRoot := t.TempDir()
	profile, err := NewDevelopmentConnectorProfile(configRoot)
	if err != nil {
		t.Fatalf("create development connector profile: %v", err)
	}

	expectedRoot := filepath.Join(configRoot, "project-space", "profiles", "dev")
	if profile.Name != "dev" || profile.Channel != ConnectorProfileChannelDev ||
		profile.Source != "source" || profile.StateRoot != expectedRoot {
		t.Fatalf("development connector profile = %#v", profile)
	}
	for label, path := range map[string]string{
		"credential":   profile.CredentialPath,
		"readiness":    profile.ReadinessPath,
		"pid":          profile.PIDPath,
		"log":          profile.LogPath,
		"launcher":     profile.LauncherPath,
		"runtime lock": profile.RuntimeLockPath,
	} {
		if filepath.Dir(path) != expectedRoot {
			t.Fatalf("%s path %q is outside %q", label, path, expectedRoot)
		}
	}

	stableCredential, err := DefaultCredentialPath()
	if err != nil {
		t.Fatalf("resolve stable credential path: %v", err)
	}
	stableReadiness, err := DefaultConnectorRuntimeReadinessPath()
	if err != nil {
		t.Fatalf("resolve stable readiness path: %v", err)
	}
	if profile.CredentialPath == stableCredential || profile.ReadinessPath == stableReadiness {
		t.Fatal("development connector profile collided with stable connector state")
	}
}

func TestDevelopmentConnectorCredentialStoreMatchesPlatformContract(t *testing.T) {
	profile, err := NewDevelopmentConnectorProfile(t.TempDir())
	if err != nil {
		t.Fatalf("create development connector profile: %v", err)
	}

	store, err := profile.NewCredentialStore()
	if runtime.GOOS == "windows" {
		if err == nil || !strings.Contains(err.Error(), "must run inside WSL") {
			t.Fatalf("native Windows credential store error = %v, want WSL guidance", err)
		}
		return
	}
	if err != nil {
		t.Fatalf("create development credential store: %v", err)
	}
	if fileStore, ok := store.(*FileStore); ok && fileStore.Path() != profile.CredentialPath {
		t.Fatalf("credential store path = %q, want %q", fileStore.Path(), profile.CredentialPath)
	}
}

func TestDevelopmentConnectorProfileRejectsNameDerivedOrMutableMetadata(t *testing.T) {
	profile, err := NewDevelopmentConnectorProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	invalid := []ConnectorProfile{
		func() ConnectorProfile { value := profile; value.Name = "my-dev-machine"; return value }(),
		func() ConnectorProfile { value := profile; value.Channel = ConnectorProfileChannelStable; return value }(),
		func() ConnectorProfile { value := profile; value.Source = "managed"; return value }(),
		func() ConnectorProfile {
			value := profile
			value.CredentialPath = filepath.Join(t.TempDir(), "credential.json")
			return value
		}(),
		func() ConnectorProfile {
			value := profile
			value.LauncherPath = profile.CredentialPath
			return value
		}(),
	}
	for _, candidate := range invalid {
		if err := ValidateConnectorProfile(candidate); err == nil {
			t.Fatalf("invalid development profile was accepted: %#v", candidate)
		}
	}
}
