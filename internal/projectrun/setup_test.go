package projectrun

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeRepositoryInspector struct {
	head string
	err  error
}

func (repository *fakeRepositoryInspector) Head(context.Context, string) (string, error) {
	return repository.head, repository.err
}

func TestPrepareRunsTrustedStepsInOrderAndIsIdempotent(t *testing.T) {
	project := writeSetupDeclaration(t)
	manager, processes, repository := newSetupTestManager(t)
	result, err := manager.Prepare(context.Background(), project, "", Streams{Stdout: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Steps) != 2 || result.Steps[0].StepID != "dependencies" ||
		result.Steps[1].StepID != "generate" || result.Steps[1].State != SetupReady {
		t.Fatalf("prepare result = %#v", result)
	}
	if got := strings.Join(processes.started[0].Argv, " "); got != "bun install --frozen-lockfile" {
		t.Fatalf("first command = %q", got)
	}
	for _, command := range processes.started {
		if command.InheritEnv {
			t.Fatal("setup inherited the ambient environment")
		}
	}
	if _, err := manager.Prepare(context.Background(), project, "", Streams{}); err != nil {
		t.Fatal(err)
	}
	if len(processes.started) != 2 {
		t.Fatalf("idempotent prepare launched %d commands", len(processes.started))
	}
	if repository.head == "" {
		t.Fatal("test repository has no HEAD")
	}
}

func TestPrepareExpectedChecksApprovedIdentityUnderSetupLock(t *testing.T) {
	project := writeSetupDeclaration(t)
	manager, processes, repository := newSetupTestManager(t)
	declaration, err := LoadDeclaration(project)
	if err != nil {
		t.Fatal(err)
	}
	expected := SetupExpectations{Commit: repository.head, DeclarationDigest: declaration.Digest}
	if _, err := manager.PrepareExpected(context.Background(), project, "dependencies", expected, Streams{}); err != nil {
		t.Fatal(err)
	}
	if len(processes.started) != 1 {
		t.Fatalf("approved setup starts = %d", len(processes.started))
	}

	repository.head = strings.Repeat("b", 40)
	if _, err := manager.PrepareExpected(context.Background(), project, "generate", expected, Streams{}); err == nil {
		t.Fatal("expected changed commit to fail closed")
	}
	if len(processes.started) != 1 {
		t.Fatal("setup command started after approved identity changed")
	}
}

func TestSetupStatusBecomesStaleForCommitOrDeclarationChange(t *testing.T) {
	project := writeSetupDeclaration(t)
	manager, _, repository := newSetupTestManager(t)
	if _, err := manager.Prepare(context.Background(), project, "dependencies", Streams{}); err != nil {
		t.Fatal(err)
	}
	repository.head = strings.Repeat("b", 40)
	status, err := manager.SetupStatus(context.Background(), project, "dependencies")
	if err != nil {
		t.Fatal(err)
	}
	if status.Steps[0].State != SetupStale {
		t.Fatalf("commit status = %#v", status.Steps[0])
	}
	repository.head = strings.Repeat("a", 40)
	body, err := os.ReadFile(filepath.Join(project, scriptsConfigPath))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, scriptsConfigPath), append(body, []byte("\n# changed\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	status, err = manager.SetupStatus(context.Background(), project, "generate")
	if err != nil {
		t.Fatal(err)
	}
	if status.Steps[0].State != SetupRequired {
		t.Fatalf("unprepared step status = %#v", status.Steps[0])
	}
}

func TestFailedAndInterruptedSetupStepsAreRetryable(t *testing.T) {
	project := writeSetupDeclaration(t)
	manager, processes, repository := newSetupTestManager(t)
	processes.runErr = errors.New("install failed")
	failed, err := manager.Prepare(context.Background(), project, "dependencies", Streams{})
	if err == nil || failed.Steps[0].State != SetupFailed {
		t.Fatalf("failed prepare = %#v error=%v", failed, err)
	}
	processes.runErr = nil
	retried, err := manager.Prepare(context.Background(), project, "dependencies", Streams{})
	if err != nil || retried.Steps[0].State != SetupReady || len(processes.started) != 2 {
		t.Fatalf("retried prepare = %#v error=%v starts=%d", retried, err, len(processes.started))
	}
	declaration, err := LoadDeclaration(project)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := setupRuntimeState{
		Directory: declaration.Root, StepID: "generate", State: SetupRunning,
		Commit: repository.head, DeclarationDigest: declaration.Digest,
		PID: 9123, ProcessIdentity: "old-process", CheckedAt: manager.timestamp(),
	}
	if err := manager.store.saveSetup(interrupted); err != nil {
		t.Fatal(err)
	}
	status, err := manager.SetupStatus(context.Background(), project, "generate")
	if err != nil || status.Steps[0].State != SetupInterrupted {
		t.Fatalf("interrupted status = %#v error=%v", status, err)
	}
	if _, err := manager.Prepare(context.Background(), project, "generate", Streams{}); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareReportsRunningAndPersistsCancellationAsInterrupted(t *testing.T) {
	project := writeSetupDeclaration(t)
	manager, processes, _ := newSetupTestManager(t)
	processes.foregroundWait = true
	processes.foregroundStarted = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan SetupCollectionResult, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := manager.Prepare(ctx, project, "dependencies", Streams{})
		finished <- result
		errCh <- err
	}()
	<-processes.foregroundStarted
	status, err := manager.SetupStatus(context.Background(), project, "dependencies")
	if err != nil || status.Steps[0].State != SetupRunning {
		t.Fatalf("running status = %#v error=%v", status, err)
	}
	cancel()
	result := <-finished
	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel error = %v", err)
	}
	if result.Steps[0].State != SetupInterrupted {
		t.Fatalf("cancel result = %#v", result)
	}
	status, err = manager.SetupStatus(context.Background(), project, "dependencies")
	if err != nil || status.Steps[0].State != SetupInterrupted {
		t.Fatalf("persisted cancellation status = %#v error=%v", status, err)
	}
}

func TestServerInventoryIsStableAndDoesNotExposeCommands(t *testing.T) {
	project := writeSetupDeclaration(t)
	result, err := ListServers(project, func() time.Time {
		return time.Date(2026, 7, 12, 1, 2, 3, 0, time.UTC)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Servers) != 2 || result.Servers[0].ServerID != "api" ||
		result.Servers[1].ServerID != "dev" || result.Servers[1].Label != "Project Space" {
		t.Fatalf("server inventory = %#v", result)
	}
	body, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"command", "bun", "healthCheck"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("inventory leaked %q: %s", forbidden, body)
		}
	}
}

func TestServerInventoryMapsVersionOneScriptsCompatibly(t *testing.T) {
	project := t.TempDir()
	writeScriptsBody(t, project, "version: 1\nscripts:\n  dev:\n    command: [bun, run, dev]\n")
	result, err := ListServers(project, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Servers) != 1 || result.Servers[0].ServerID != "dev" || result.Servers[0].Label != "dev" {
		t.Fatalf("version 1 inventory = %#v", result)
	}
}

func newSetupTestManager(t *testing.T) (*Manager, *fakeProcesses, *fakeRepositoryInspector) {
	t.Helper()
	processes := newFakeProcesses()
	repository := &fakeRepositoryInspector{head: strings.Repeat("a", 40)}
	manager, err := NewManager(Dependencies{
		Processes: processes, Portless: newFakeLocalRouter(), Tailnet: newFakeTailnet(), Prober: newFakeProber(),
		Ports:     fixedPorts{local: 43117, public: 44419},
		StateRoot: filepath.Join(t.TempDir(), "runtime"), Repository: repository,
		Now: func() time.Time { return time.Date(2026, 7, 12, 1, 2, 3, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager, processes, repository
}

func writeSetupDeclaration(t *testing.T) string {
	t.Helper()
	project := t.TempDir()
	writeScriptsBody(t, project, "version: 2\nsetup:\n  - id: dependencies\n    command: [bun, install, --frozen-lockfile]\n  - id: generate\n    command: [bun, run, generate]\nservers:\n  dev:\n    label: Project Space\n    command: [bun, run, dev]\n  api:\n    command: [bun, run, api]\n")
	return project
}
