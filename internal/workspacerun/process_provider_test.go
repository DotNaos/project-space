package workspacerun

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

func TestProcessProviderPassesRuntimeCredentialOnlyThroughProtectedBootstrap(t *testing.T) {
	runner := &runtimeProcessRunner{process: projectrun.ProcessRef{PID: 4242, Identity: strings.Repeat("a", 64)}, alive: true}
	generationHome := filepath.Join(t.TempDir(), "generation")
	token := strings.Repeat("A", 43)
	provider := ProcessProvider{Runner: runner}
	logFile, err := os.CreateTemp(t.TempDir(), "runtime-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	_, err = provider.Start(context.Background(), LaunchRequest{
		Workspace: WorkspaceIdentity{WorkspaceID: testRuntimeBinding().WorkspaceID, Branch: "issue-625", Head: strings.Repeat("d", 40)},
		Binding:   testRuntimeBinding(), Directory: t.TempDir(), Manifest: Manifest{},
		LogFile: logFile, GenerationHome: generationHome,
		ProjectBinary: "/verified/project", CodexBinary: "/verified/codex", RuntimeSession: &RuntimeSessionBootstrap{
			Endpoint: "wss://projects.example/api/workspace-runtimes/socket", Token: token,
			EnvironmentID: "33333333-3333-4333-8333-333333333333", ExpiresAt: time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339),
			RuntimeVersion: "0.4.66", Capabilities: []string{"runtime.lifecycle", "runtime.heartbeat"},
			RequestedCapabilities: []string{"runtime.codex.v1"}, OwnerUserID: "owner",
			ControllerBinary: "/verified/project-space-connector",
		}, Commit: func(RuntimeHandle) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	argv := strings.Join(runner.command.Argv, " ")
	if strings.Contains(argv, token) || argv != "/verified/project __workspace-runtime-session --bootstrap "+filepath.Join(generationHome, "runtime-session-bootstrap.json") {
		t.Fatalf("unsafe runtime argv = %q", argv)
	}
	bootstrapPath := filepath.Join(generationHome, "runtime-session-bootstrap.json")
	info, err := os.Stat(bootstrapPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("bootstrap protection = %#v, error=%v", info, err)
	}
	var bootstrap map[string]interface{}
	encoded, _ := os.ReadFile(bootstrapPath)
	if json.Unmarshal(encoded, &bootstrap) != nil || bootstrap["token"] != token {
		t.Fatal("protected bootstrap did not contain the scoped credential")
	}
	if bootstrap["logPointer"] != "runtime-log:/"+testRuntimeBinding().WorkspaceID+"/"+testRuntimeBinding().Generation {
		t.Fatalf("runtime launch binding = %#v", bootstrap)
	}
	readyPath := filepath.Join(generationHome, "runtime-session-ready")
	if _, err := os.Lstat(readyPath); !os.IsNotExist(err) {
		t.Fatalf("provider published readiness before the full Manager start completed: %v", err)
	}
	if capabilities, ok := bootstrap["capabilities"].([]interface{}); !ok ||
		containsInterface(capabilities, "runtime.codex.v1") {
		t.Fatalf("initial effective capabilities = %#v", bootstrap["capabilities"])
	}
	if requested, ok := bootstrap["requestedCapabilities"].([]interface{}); !ok ||
		!reflect.DeepEqual(requested, []interface{}{"runtime.codex.v1"}) {
		t.Fatalf("requested promotion capabilities = %#v", bootstrap["requestedCapabilities"])
	}
}

func containsInterface(values []interface{}, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestProcessProviderUsesGenerationScopedEnvironmentWithoutInheritance(t *testing.T) {
	runner := &runtimeProcessRunner{
		process: projectrun.ProcessRef{PID: 4242, Identity: strings.Repeat("a", 64)},
		alive:   true,
	}
	provider := ProcessProvider{Runner: runner}
	generationHome := filepath.Join(t.TempDir(), "generation")
	binding := testRuntimeBinding()
	var committed RuntimeHandle
	logFile, err := os.CreateTemp(t.TempDir(), "runtime-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()

	handle, err := provider.Start(context.Background(), LaunchRequest{
		Binding:        binding,
		Directory:      t.TempDir(),
		Manifest:       Manifest{},
		LogFile:        logFile,
		GenerationHome: generationHome,
		ProjectBinary:  "/verified/project",
		CodexBinary:    "/verified/codex",
		Commit: func(handle RuntimeHandle) error {
			committed = handle
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(handle, committed) {
		t.Fatalf("handle=%#v committed=%#v", handle, committed)
	}
	if runner.command.InheritEnv {
		t.Fatal("runtime process inherited the connector environment")
	}
	if got := strings.Join(runner.command.Argv, " "); got != "/verified/codex app-server --listen unix://"+appServerSocketPath(binding)+" --strict-config" {
		t.Fatalf("argv = %q", got)
	}
	environment := environmentValues(runner.command.Env)
	want := map[string]string{
		"PROJECT_WORKSPACE_ID":            binding.WorkspaceID,
		"PROJECT_RUNTIME_GENERATION":      binding.Generation,
		"PROJECT_RUNTIME_MANIFEST_DIGEST": binding.ManifestDigest,
		"PROJECT_RUNTIME_OWNERSHIP_TOKEN": binding.OwnershipToken,
		"HOME":                            filepath.Join(generationHome, "home"),
		"XDG_CONFIG_HOME":                 filepath.Join(generationHome, "config"),
		"XDG_DATA_HOME":                   filepath.Join(generationHome, "data"),
		"XDG_CACHE_HOME":                  filepath.Join(generationHome, "cache"),
		"CODEX_HOME":                      filepath.Join(generationHome, "codex"),
	}
	if !reflect.DeepEqual(environment, want) {
		t.Fatalf("environment = %#v, want %#v", environment, want)
	}
	for _, key := range []string{"HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME"} {
		path := want[key]
		info, statErr := filepath.Glob(path)
		if statErr != nil || len(info) != 1 {
			t.Fatalf("generation directory %q was not created", path)
		}
	}
}

func TestProcessProviderFailsClosedWhenProcessIdentityChanges(t *testing.T) {
	runner := &runtimeProcessRunner{
		process: projectrun.ProcessRef{PID: 4242, Identity: strings.Repeat("a", 64)},
		alive:   true,
	}
	provider := ProcessProvider{Runner: runner}
	binding := testRuntimeBinding()
	handle := RuntimeHandle{Kind: ResourceProcess, Process: processHandle(runner.process, binding, appServerSocketPath(binding))}

	observation, err := provider.Inspect(context.Background(), handle, binding)
	if err != nil {
		t.Fatal(err)
	}
	if !observation.Exists || !observation.Owned || !observation.Running {
		t.Fatalf("healthy observation = %#v", observation)
	}

	runner.process.Identity = strings.Repeat("b", 64)
	observation, err = provider.Inspect(context.Background(), handle, binding)
	if err != nil {
		t.Fatal(err)
	}
	if !observation.Exists || observation.Owned || observation.Running {
		t.Fatalf("changed ownership was accepted: %#v", observation)
	}
	if err := provider.Stop(context.Background(), handle, testRuntimeBinding(), time.Second); err == nil {
		t.Fatal("changed process identity was stopped")
	}
	if runner.stopped {
		t.Fatal("changed process identity was mutated")
	}
	if err := provider.Clean(context.Background(), handle, testRuntimeBinding()); err == nil {
		t.Fatal("changed process identity was cleaned as absent")
	}
}

func testRuntimeBinding() RuntimeBinding {
	return RuntimeBinding{
		WorkspaceID:    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		Generation:     "11111111-1111-4111-8111-111111111111",
		ManifestDigest: strings.Repeat("c", 64),
		OwnershipToken: "22222222-2222-4222-8222-222222222222",
	}
}

func environmentValues(entries []string) map[string]string {
	result := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			result[key] = value
		}
	}
	return result
}

type runtimeProcessRunner struct {
	process   projectrun.ProcessRef
	command   projectrun.Command
	alive     bool
	suspended bool
	stopped   bool
}

func (runner *runtimeProcessRunner) StartDetachedWithOutput(command projectrun.Command, _ *os.File, commit projectrun.ProcessCommit) (projectrun.ProcessRef, error) {
	runner.command = command
	if err := commit(runner.process); err != nil {
		return projectrun.ProcessRef{}, err
	}
	return runner.process, nil
}

func (runner *runtimeProcessRunner) Alive(process projectrun.ProcessRef) bool {
	return runner.alive && process == runner.process && !runner.stopped
}

func (runner *runtimeProcessRunner) PIDExists(pid int) bool {
	return runner.alive && runner.process.PID == pid && !runner.stopped
}

func (runner *runtimeProcessRunner) Suspended(process projectrun.ProcessRef) (bool, error) {
	if !runner.Alive(process) {
		return false, context.Canceled
	}
	return runner.suspended, nil
}

func (runner *runtimeProcessRunner) SuspendGroup(process projectrun.ProcessRef) error {
	if !runner.Alive(process) {
		return context.Canceled
	}
	runner.suspended = true
	return nil
}

func (runner *runtimeProcessRunner) ResumeGroup(process projectrun.ProcessRef) error {
	if !runner.Alive(process) {
		return context.Canceled
	}
	runner.suspended = false
	return nil
}

func (runner *runtimeProcessRunner) StopGroup(process projectrun.ProcessRef, _ time.Duration) error {
	if !runner.Alive(process) {
		return context.Canceled
	}
	runner.stopped = true
	runner.alive = false
	return nil
}

func (runner *runtimeProcessRunner) OwnsUnixSocket(process projectrun.ProcessRef, _ string) (bool, error) {
	return runner.Alive(process), nil
}
