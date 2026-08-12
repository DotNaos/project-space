package workspacerun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

func TestRuntimeLifecycleReusesOnlyExactGenerationAndPreservesCheckout(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	ctx := context.Background()

	started, err := manager.Start(ctx, workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	if started.Disposition != DispositionCreated || started.State != StateRunning || provider.starts != 1 {
		t.Fatalf("first start=%#v provider starts=%d", started, provider.starts)
	}
	if provider.binding.Generation != started.Generation || provider.binding.WorkspaceID != started.WorkspaceID || provider.binding.ManifestDigest != started.ManifestDigest {
		t.Fatalf("provider binding=%#v result=%#v", provider.binding, started)
	}

	reused, err := manager.Start(ctx, workspace, OperationOptions{Mode: ModeProcess, ExpectedGeneration: started.Generation}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	if reused.Disposition != DispositionReused || provider.starts != 1 {
		t.Fatalf("duplicate start=%#v provider starts=%d", reused, provider.starts)
	}

	wrongGeneration := "99999999-9999-4999-8999-999999999999"
	if _, err := manager.Stop(ctx, workspace, OperationOptions{ExpectedGeneration: wrongGeneration}, Streams{}); err == nil || !strings.Contains(err.Error(), "generation mismatch") {
		t.Fatalf("wrong-generation stop error=%v", err)
	}
	if provider.stops != 0 {
		t.Fatalf("wrong generation stopped %d resources", provider.stops)
	}

	marker := filepath.Join(workspace, "checkout-must-survive.txt")
	if err := os.WriteFile(marker, []byte("keep\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stopped, err := manager.Stop(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	if stopped.State != StateStopped || provider.stops != 1 {
		t.Fatalf("stop=%#v provider stops=%d", stopped, provider.stops)
	}
	cleaned, err := manager.Clean(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err != nil {
		t.Fatal(err)
	}
	if cleaned.Disposition != DispositionCleaned || provider.cleans != 1 {
		t.Fatalf("clean=%#v provider cleans=%d", cleaned, provider.cleans)
	}
	if body, err := os.ReadFile(marker); err != nil || string(body) != "keep\n" {
		t.Fatalf("checkout marker body=%q err=%v", body, err)
	}
	if _, err := os.Stat(filepath.Join(workspace, manifestPath)); err != nil {
		t.Fatalf("clean removed the Workspace checkout: %v", err)
	}
	identity, err := manager.identity.Resolve(ctx, workspace)
	if err != nil {
		t.Fatal(err)
	}
	cleanedRecord, exists, err := manager.store.load(identity)
	if err != nil || !exists || !cleanedRecord.GenerationRemoved || cleanedRecord.GenerationArchive == "" || cleanedRecord.State != StateStopped {
		t.Fatalf("runtime tombstone after clean: record=%#v exists=%v err=%v", cleanedRecord, exists, err)
	}
	if _, err := os.Lstat(manager.store.generationHome(cleanedRecord.WorkspaceID, cleanedRecord.Generation)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("active generation still exists after clean: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(manager.store.root, "generations", cleanedRecord.GenerationArchive)); err != nil {
		t.Fatalf("retained proof-bound generation is missing: %v", err)
	}
}

func TestReconcileMarksCrashedOwnedRuntimeFailedWithoutGuessing(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	provider.exists = false
	provider.running = false

	reconciled, err := manager.Reconcile(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err != nil {
		t.Fatal(err)
	}
	if reconciled.State != StateFailed || reconciled.PID != nil || provider.stops != 0 {
		t.Fatalf("reconcile=%#v provider stops=%d", reconciled, provider.stops)
	}
	if reconciled.LastError == nil || !strings.Contains(*reconciled.LastError, "exited") {
		t.Fatalf("reconcile error=%v", reconciled.LastError)
	}
}

func TestReconcileFailsClosedForAmbiguousRuntimeOwnership(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	provider.owned = false

	reconciled, err := manager.Reconcile(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err == nil || !strings.Contains(err.Error(), "ownership is ambiguous") {
		t.Fatalf("reconcile=%#v error=%v", reconciled, err)
	}
	if reconciled.State != StateStale || provider.stops != 0 || provider.cleans != 0 {
		t.Fatalf("ambiguous reconcile=%#v stops=%d cleans=%d", reconciled, provider.stops, provider.cleans)
	}
}

func TestStopPreflightsMissingRuntimeBeforeChangingDevServers(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := manager.identity.Resolve(context.Background(), workspace)
	if err != nil {
		t.Fatal(err)
	}
	record, exists, err := manager.store.load(identity)
	if err != nil || !exists {
		t.Fatalf("load runtime: exists=%v err=%v", exists, err)
	}
	record.ExpectedDevServers = []string{"docs"}
	record.DevServers = []ManagedDevServer{{
		Name: "docs", ServerID: "server-docs", TmuxSession: "tmux-docs", State: string(projectrun.StateRunning),
	}}
	if err := manager.store.save(record); err != nil {
		t.Fatal(err)
	}
	project := &countingLifecycleProject{}
	manager.project = project
	provider.exists = false
	provider.running = false

	result, err := manager.Stop(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation}, Streams{})
	if err == nil || !strings.Contains(err.Error(), "resource is missing") {
		t.Fatalf("stop=%#v error=%v", result, err)
	}
	if provider.stops != 0 || project.statuses != 0 || project.stops != 0 {
		t.Fatalf("preflight mutated resources: provider stops=%d statuses=%d dev-server stops=%d", provider.stops, project.statuses, project.stops)
	}
}

func TestStopUsesStoredRuntimeBindingAfterCheckoutHeadMoves(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	original := manager.identity.(lifecycleIdentityResolver).identity
	moved := original
	moved.Head = strings.Repeat("c", 40)
	manager.identity = lifecycleIdentityResolver{identity: moved}

	stopped, err := manager.Stop(context.Background(), workspace, OperationOptions{
		Mode: ModeProcess, ExpectedCommit: original.Head, ExpectedDigest: started.ManifestDigest, ExpectedGeneration: started.Generation,
	}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	if stopped.SourceHead != original.Head || provider.stops != 1 {
		t.Fatalf("stop=%#v provider stops=%d", stopped, provider.stops)
	}
}

func TestStopPreflightsEveryDevServerBeforeAnyMutation(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, _ := manager.store.load(identity)
	record.ExpectedDevServers = []string{"first", "foreign"}
	record.DevServers = []ManagedDevServer{
		{Name: "first", ServerID: "server-first", TmuxSession: "tmux-first", State: string(projectrun.StateRunning)},
		{Name: "foreign", ServerID: "server-foreign", TmuxSession: "tmux-foreign", State: string(projectrun.StateRunning)},
	}
	if err := manager.store.save(record); err != nil {
		t.Fatal(err)
	}
	project := &preflightLifecycleProject{workspaceID: record.WorkspaceID, generation: record.Generation}
	manager.project = project
	result, err := manager.Stop(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation}, Streams{})
	if err == nil || !strings.Contains(err.Error(), "foreign") {
		t.Fatalf("stop=%#v error=%v", result, err)
	}
	if provider.stops != 0 || project.stops != 0 {
		t.Fatalf("failed preflight mutated resources: provider stops=%d dev-server stops=%d", provider.stops, project.stops)
	}
}

func TestReconcileCompletesStopAfterOwnedProcessIsAuthoritativelyAbsent(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, _ := manager.store.load(identity)
	record.State = StateStopping
	if err := manager.store.save(record); err != nil {
		t.Fatal(err)
	}
	provider.exists = false
	provider.running = false
	reconciled, err := manager.Reconcile(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err != nil || reconciled.State != StateStopped || provider.stops != 0 {
		t.Fatalf("reconcile=%#v error=%v provider stops=%d", reconciled, err, provider.stops)
	}
}

func TestStartFailureAfterCommittedHandleConvergesToFailed(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	provider.failAfterCommit = true
	result, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err == nil || result.State != StateFailed {
		t.Fatalf("start=%#v error=%v", result, err)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, exists, loadErr := manager.store.load(identity)
	if loadErr != nil || !exists || record.State != StateFailed || record.Handle.Kind != "" {
		t.Fatalf("record=%#v exists=%v error=%v", record, exists, loadErr)
	}
}

func TestReconcileAdoptsOnlyPersistedStartIntentAndCleansIt(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, _ := manager.store.load(identity)
	record.State = StateStarting
	record.ExpectedDevServers = []string{"docs"}
	record.DevServerOperation = &devServerOperation{Name: "docs", Action: devServerStarting}
	if err := manager.store.save(record); err != nil {
		t.Fatal(err)
	}
	project := &ledgerLifecycleProject{session: projectrun.ServeResult{
		Script: "docs", Directory: record.Directory, WorkspaceID: record.WorkspaceID,
		RuntimeGeneration: record.Generation, ServerID: "server-docs", TmuxSession: "tmux-docs",
		State: projectrun.StateRunning,
	}}
	manager.project = project
	provider.exists = false
	provider.running = false
	reconciled, err := manager.Reconcile(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err != nil || reconciled.State != StateFailed || project.stops != 1 || len(reconciled.DevServers) != 0 {
		t.Fatalf("reconcile=%#v error=%v stops=%d", reconciled, err, project.stops)
	}
}

func TestReconcileConfirmsPersistedStopIntentWasAlreadyAbsent(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, _ := manager.store.load(identity)
	record.State = StateStopping
	record.ExpectedDevServers = []string{"docs"}
	record.DevServers = []ManagedDevServer{{
		Name: "docs", ServerID: "server-docs", TmuxSession: "tmux-docs", State: string(projectrun.StateRunning),
	}}
	record.DevServerOperation = &devServerOperation{Name: "docs", Action: devServerStopping}
	if err := manager.store.save(record); err != nil {
		t.Fatal(err)
	}
	manager.project = &ledgerLifecycleProject{}
	provider.exists = false
	provider.running = false
	reconciled, err := manager.Reconcile(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err != nil || reconciled.State != StateStopped || len(reconciled.DevServers) != 0 {
		t.Fatalf("reconcile=%#v error=%v", reconciled, err)
	}
}

func TestReconcileCleansExactInterruptedDevServerState(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, _ := manager.store.load(identity)
	record.State = StateStarting
	record.ExpectedDevServers = []string{"docs"}
	record.DevServerOperation = &devServerOperation{Name: "docs", Action: devServerStarting}
	if err := manager.store.save(record); err != nil {
		t.Fatal(err)
	}
	message := "serve session was interrupted while starting"
	project := &ledgerLifecycleProject{session: projectrun.ServeResult{
		Script: "docs", Directory: record.Directory, WorkspaceID: record.WorkspaceID,
		RuntimeGeneration: record.Generation, ServerID: "server-docs", TmuxSession: "tmux-docs",
		State: projectrun.StateError, LastError: &message,
	}}
	manager.project = project
	provider.exists = false
	provider.running = false
	reconciled, err := manager.Reconcile(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err != nil || reconciled.State != StateFailed || project.stops != 1 || len(reconciled.DevServers) != 0 {
		t.Fatalf("reconcile=%#v error=%v stops=%d", reconciled, err, project.stops)
	}
}

func TestReconcileFailsClosedWhenReadOnlyInventoryIsIncomplete(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, _ := manager.store.load(identity)
	record.State = StateStarting
	record.ExpectedDevServers = []string{"docs"}
	record.DevServerOperation = &devServerOperation{Name: "docs", Action: devServerStarting}
	if err := manager.store.save(record); err != nil {
		t.Fatal(err)
	}
	message := "interrupted exact session"
	project := &ledgerLifecycleProject{session: projectrun.ServeResult{
		Script: "docs", Directory: record.Directory, WorkspaceID: record.WorkspaceID,
		RuntimeGeneration: record.Generation, ServerID: "server-docs", TmuxSession: "tmux-docs",
		State: projectrun.StateError, LastError: &message,
	}, observeErr: errors.New("separate invalid persisted session"), errorCount: 1}
	manager.project = project
	provider.exists = false
	provider.running = false
	reconciled, err := manager.Reconcile(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err == nil || reconciled.State != StateStale || project.stops != 0 {
		t.Fatalf("reconcile=%#v error=%v stops=%d", reconciled, err, project.stops)
	}
	stored, _, loadErr := manager.store.load(identity)
	if loadErr != nil || stored.DevServerOperation == nil || stored.DevServerOperation.Name != "docs" {
		t.Fatalf("incomplete inventory lost operation intent: record=%#v err=%v", stored, loadErr)
	}
}

func TestSuspendReconcilesFailedStopBeforeRestartingServers(t *testing.T) {
	manager, _, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, _ := manager.store.load(identity)
	record.ExpectedDevServers = []string{"first", "second"}
	record.DevServers = []ManagedDevServer{
		{Name: "first", ServerID: "server-first", TmuxSession: "tmux-first", State: string(projectrun.StateRunning)},
		{Name: "second", ServerID: "server-second", TmuxSession: "tmux-second", State: string(projectrun.StateRunning)},
	}
	if err := manager.store.save(record); err != nil {
		t.Fatal(err)
	}
	project := newRollbackLifecycleProject(record)
	manager.project = project
	result, err := manager.Suspend(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err == nil || result.State != StateRunning {
		t.Fatalf("suspend=%#v error=%v", result, err)
	}
	stored, _, loadErr := manager.store.load(identity)
	if loadErr != nil || stored.State != StateRunning || stored.DevServerOperation != nil || len(stored.DevServers) != 2 {
		t.Fatalf("stored=%#v error=%v", stored, loadErr)
	}
	if project.starts != 2 {
		t.Fatalf("rollback restarted %d servers, want 2", project.starts)
	}
}

func TestInitialStartDoesNotCleanupWhenDevServerInventoryIsUncertain(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	writeDevServerRuntimeFixture(t, workspace, []string{"first", "second"})
	project := newUncertainLifecycleProject()
	project.failStartName = "second"
	project.observeErr = errors.New("read-only session inventory unavailable")
	manager.project = project
	result, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err == nil || result.State != StateStale || provider.stops != 0 || project.stops != 0 {
		t.Fatalf("start=%#v error=%v provider stops=%d server stops=%d", result, err, provider.stops, project.stops)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, loadErr := manager.store.load(identity)
	if loadErr != nil || record.DevServerOperation == nil || record.DevServerOperation.Name != "second" || record.DevServerOperation.Action != devServerStarting {
		t.Fatalf("uncertain start intent was not preserved: record=%#v error=%v", record, loadErr)
	}
}

func TestResumeDoesNotRollbackWhenDevServerInventoryIsUncertain(t *testing.T) {
	manager, provider, workspace := newRuntimeTestManager(t)
	writeDevServerRuntimeFixture(t, workspace, []string{"first", "second"})
	project := newUncertainLifecycleProject()
	manager.project = project
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Suspend(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil {
		t.Fatal(err)
	}
	stopsBefore, suspendsBefore := project.stops, provider.suspends
	project.failStartName = "second"
	project.observeErr = errors.New("read-only session inventory unavailable")
	result, err := manager.Resume(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation})
	if err == nil || result.State != StateStale || project.stops != stopsBefore || provider.suspends != suspendsBefore {
		t.Fatalf("resume=%#v error=%v stops=%d/%d suspends=%d/%d", result, err, project.stops, stopsBefore, provider.suspends, suspendsBefore)
	}
	identity, _ := manager.identity.Resolve(context.Background(), workspace)
	record, _, loadErr := manager.store.load(identity)
	if loadErr != nil || record.DevServerOperation == nil || record.DevServerOperation.Name != "second" || record.DevServerOperation.Action != devServerStarting {
		t.Fatalf("uncertain resume intent was not preserved: record=%#v error=%v", record, loadErr)
	}
}

func writeDevServerRuntimeFixture(t *testing.T, workspace string, names []string) {
	t.Helper()
	path := filepath.Join(workspace, manifestPath)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := make([]string, len(names))
	for index, name := range names {
		lines[index] = "  - " + name
	}
	body = []byte(strings.Replace(string(body), "devServers: []", "devServers:\n"+strings.Join(lines, "\n"), 1))
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	scripts := "version: 1\nscripts:\n"
	for _, name := range names {
		scripts += "  " + name + ":\n    command: [\"true\"]\n"
	}
	if err := os.WriteFile(filepath.Join(workspace, ".project", "scripts.yaml"), []byte(scripts), 0o600); err != nil {
		t.Fatal(err)
	}
}

func newRuntimeTestManager(t *testing.T) (*Manager, *lifecycleProvider, string) {
	t.Helper()
	workspace := t.TempDir()
	writeRuntimeFixture(t, workspace, ModeProcess)
	identity := lifecycleWorkspaceIdentity(workspace)
	provider := &lifecycleProvider{exists: true, owned: true, running: true}
	tokens := []string{
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
	}
	manager, err := NewManager(Dependencies{
		StateRoot: t.TempDir(),
		Identity:  lifecycleIdentityResolver{identity: identity},
		Checkout:  lifecycleAllowCheckout{},
		Project:   &lifecycleProject{},
		Providers: []RuntimeProvider{provider},
		Verifier:  lifecycleVerifier{},
		Now: func() time.Time {
			return time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)
		},
		Token: func() (string, error) {
			if len(tokens) == 0 {
				return "", errors.New("test token sequence exhausted")
			}
			value := tokens[0]
			tokens = tokens[1:]
			return value, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager, provider, workspace
}

type lifecycleIdentityResolver struct{ identity WorkspaceIdentity }

func (resolver lifecycleIdentityResolver) Resolve(context.Context, string) (WorkspaceIdentity, error) {
	return resolver.identity, nil
}

func lifecycleWorkspaceIdentity(directory string) WorkspaceIdentity {
	return WorkspaceIdentity{
		WorkspaceID:   "ws_0123456789abcdef01234567",
		Repository:    filepath.Join(directory, ".git-common"),
		Directory:     directory,
		GitDirectory:  filepath.Join(directory, ".git-worktree"),
		IdentityProof: strings.Repeat("a", 64),
		Branch:        "issue-624-workspace-runtimes",
		Head:          strings.Repeat("b", 40),
	}
}

type lifecycleAllowCheckout struct{}

func (lifecycleAllowCheckout) Verify(context.Context, WorkspaceIdentity, OperationOptions) error {
	return nil
}

type lifecycleVerifier struct{}

func (lifecycleVerifier) Verify(context.Context, Manifest) (VerifiedTools, error) {
	return VerifiedTools{ProjectBinary: "/verified/project", CodexBinary: "/verified/codex"}, nil
}

type lifecycleProject struct{}

func (*lifecycleProject) PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error) {
	return projectrun.SetupCollectionResult{}, nil
}

func (*lifecycleProject) RunWithOptions(context.Context, string, string, projectrun.Streams, projectrun.RunOptions) (projectrun.RunResult, error) {
	return projectrun.RunResult{}, nil
}

func (*lifecycleProject) StartWithOptions(_ context.Context, _ string, name string, options projectrun.StartOptions) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{
		ServerID:          "server-" + name,
		TmuxSession:       "tmux-" + name,
		WorkspaceID:       options.WorkspaceID,
		RuntimeGeneration: options.RuntimeGeneration,
		State:             projectrun.StateRunning,
	}, nil
}
func (*lifecycleProject) ObserveSessions(context.Context) (projectrun.ServeCollectionResult, error) {
	return projectrun.ServeCollectionResult{Sessions: []projectrun.ServeResult{}}, nil
}

func (*lifecycleProject) Status(context.Context, string, string) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, errors.New("unexpected dev-server status")
}

func (*lifecycleProject) StopExpected(context.Context, string, string, string, string) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, errors.New("unexpected dev-server stop")
}

type countingLifecycleProject struct {
	statuses int
	stops    int
}
