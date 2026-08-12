package workspacerun

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestIsStrictAndRejectsUnenforcedProcessLimits(t *testing.T) {
	directory := t.TempDir()
	writeRuntimeFixture(t, directory, ModeProcess)
	if _, err := LoadManifest(directory); err != nil {
		t.Fatalf("load valid manifest: %v", err)
	}

	path := filepath.Join(directory, manifestPath)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for name, replacement := range map[string]string{
		"unknown field":   strings.Replace(string(body), "version: 1", "version: 1\nunknown: true", 1),
		"version range":   strings.Replace(string(body), "version: 1.2.3", "version: ^1.2.3", 1),
		"positive limits": strings.Replace(string(body), "cpuMillis: 0", "cpuMillis: 100", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(replacement), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadManifest(directory); err == nil {
				t.Fatalf("invalid manifest was accepted")
			}
		})
	}
}

func TestDevcontainerFixtureRejectsHostAccessAndMutableImages(t *testing.T) {
	directory := t.TempDir()
	writeRuntimeFixture(t, directory, ModeDevcontainer)
	if _, err := LoadManifest(directory); err != nil {
		t.Fatalf("load safe devcontainer manifest: %v", err)
	}
	path := filepath.Join(directory, ".devcontainer", "devcontainer.json")
	unsafe := `{"image":"alpine:latest","remoteUser":"node","workspaceFolder":"/workspace","mounts":["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"]}`
	if err := os.WriteFile(path, []byte(unsafe), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadManifest(directory); err == nil {
		t.Fatal("unsafe devcontainer declaration was accepted")
	}
}

func TestRepositoryDevcontainerFixtureIsACompleteResolvedPlan(t *testing.T) {
	directory := filepath.Join("..", "..", "tests", "fixtures", "workspace-runtime")
	identity := lifecycleWorkspaceIdentity(directory)
	plan, err := resolvePlan(context.Background(), lifecycleIdentityResolver{identity: identity}, directory, ModeDevcontainer)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != ModeDevcontainer || !sha256Pattern.MatchString(plan.Digest) || plan.Resolution.Manifest.Resources.Empty() {
		t.Fatalf("fixture plan = %#v", plan)
	}
}

func writeRuntimeFixture(t *testing.T, directory string, mode Mode) {
	t.Helper()
	projectDirectory := filepath.Join(directory, ".project")
	if err := os.MkdirAll(projectDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	scripts := "version: 1\nscripts:\n  fixture:\n    command: [\"true\"]\n"
	if err := os.WriteFile(filepath.Join(projectDirectory, "scripts.yaml"), []byte(scripts), 0o600); err != nil {
		t.Fatal(err)
	}
	devcontainer := ""
	if mode == ModeDevcontainer {
		containerDirectory := filepath.Join(directory, ".devcontainer")
		if err := os.MkdirAll(containerDirectory, 0o700); err != nil {
			t.Fatal(err)
		}
		configuration := `{"image":"alpine@sha256:` + strings.Repeat("a", 64) + `","remoteUser":"node","workspaceFolder":"/workspace","runArgs":["--init"]}`
		if err := os.WriteFile(filepath.Join(containerDirectory, "devcontainer.json"), []byte(configuration), 0o600); err != nil {
			t.Fatal(err)
		}
		devcontainer = "devcontainer:\n  path: .devcontainer/devcontainer.json\n"
	}
	manifest := "version: 1\n" +
		"defaultMode: " + string(mode) + "\n" +
		"credentialScope: workspace-generation\n" +
		"projectProtocol: 1\n" +
		"projectRuntime:\n  id: project\n  version: 1.2.3\n  sha256: " + strings.Repeat("a", 64) + "\n" +
		"codex:\n  id: codex\n  version: 2.3.4\n  sha256: " + strings.Repeat("b", 64) + "\n" +
		"toolchains: []\ninputs: []\nsetup: []\nstartup: []\nshutdown: []\ndevServers: []\nports: []\n" +
		"resources:\n  cpuMillis: 0\n  memoryMiB: 0\n  pids: 0\n" + devcontainer
	if err := os.WriteFile(filepath.Join(projectDirectory, "runtime.yaml"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
}
