package workspacerun

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

func TestProcessProviderUsesGenerationScopedEnvironmentWithoutInheritance(t *testing.T) {
	runner := &runtimeProcessRunner{
		process: projectrun.ProcessRef{PID: 4242, Identity: strings.Repeat("a", 64)},
		alive:   true,
	}
	provider := ProcessProvider{Runner: runner}
	generationHome := filepath.Join(t.TempDir(), "generation")
	binding := testRuntimeBinding()
	var committed RuntimeHandle

	handle, err := provider.Start(context.Background(), LaunchRequest{
		Binding:        binding,
		Directory:      t.TempDir(),
		Manifest:       Manifest{},
		LogPath:        filepath.Join(t.TempDir(), "runtime.log"),
		GenerationHome: generationHome,
		ProjectBinary:  "/verified/project",
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
	if got := strings.Join(runner.command.Argv, " "); got != "/verified/project __workspace-runtime-idle" {
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
	handle := RuntimeHandle{Kind: ResourceProcess, Process: processHandle(runner.process, binding)}

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
		WorkspaceID:    "ws_0123456789abcdef01234567",
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

func (runner *runtimeProcessRunner) StartDetached(command projectrun.Command, _ string, commit projectrun.ProcessCommit) (projectrun.ProcessRef, error) {
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
