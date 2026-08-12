package workspacerun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
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
	if _, exists, err := manager.store.load(identity); err != nil || exists {
		t.Fatalf("runtime state after clean: exists=%v err=%v", exists, err)
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
	return VerifiedTools{ProjectBinary: "/verified/project"}, nil
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

func (*lifecycleProject) Status(context.Context, string, string) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, errors.New("unexpected dev-server status")
}

func (*lifecycleProject) StopExpected(context.Context, string, string, string, string) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, errors.New("unexpected dev-server stop")
}

type lifecycleProvider struct {
	starts  int
	stops   int
	cleans  int
	exists  bool
	owned   bool
	running bool
	handle  RuntimeHandle
	binding RuntimeBinding
}

func (*lifecycleProvider) Mode() Mode { return ModeProcess }

func (provider *lifecycleProvider) Start(_ context.Context, request LaunchRequest) (RuntimeHandle, error) {
	provider.starts++
	provider.binding = request.Binding
	provider.handle = RuntimeHandle{
		Kind: ResourceProcess,
		Process: &ProcessHandle{
			PID:           4242,
			Identity:      strings.Repeat("d", 64),
			BindingDigest: bindingDigest(request.Binding),
		},
	}
	provider.exists = true
	provider.owned = true
	provider.running = true
	if err := request.Commit(provider.handle); err != nil {
		return RuntimeHandle{}, err
	}
	return provider.handle, nil
}

func (provider *lifecycleProvider) Inspect(_ context.Context, handle RuntimeHandle, binding RuntimeBinding) (ProviderObservation, error) {
	if !reflect.DeepEqual(handle, provider.handle) || binding != provider.binding {
		return ProviderObservation{}, errors.New("runtime binding changed")
	}
	return ProviderObservation{
		Exists: provider.exists, Owned: provider.owned, Running: provider.running,
		Handle: provider.handle,
	}, nil
}

func (provider *lifecycleProvider) Suspend(context.Context, RuntimeHandle, RuntimeBinding) error {
	provider.running = false
	return nil
}

func (provider *lifecycleProvider) Resume(context.Context, RuntimeHandle, RuntimeBinding) error {
	provider.running = true
	return nil
}

func (provider *lifecycleProvider) Stop(_ context.Context, handle RuntimeHandle, binding RuntimeBinding, _ time.Duration) error {
	if !reflect.DeepEqual(handle, provider.handle) || binding != provider.binding || !provider.owned {
		return errors.New("refusing changed runtime ownership")
	}
	provider.stops++
	provider.exists = false
	provider.running = false
	return nil
}

func (provider *lifecycleProvider) Clean(_ context.Context, handle RuntimeHandle, binding RuntimeBinding) error {
	if !reflect.DeepEqual(handle, provider.handle) || binding != provider.binding || provider.exists {
		return errors.New("refusing changed or live runtime")
	}
	provider.cleans++
	return nil
}
