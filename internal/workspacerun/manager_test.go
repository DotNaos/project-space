package workspacerun

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

func TestWorkspaceLifecycleReusesGenerationAndPreservesCheckout(t *testing.T) {
	directory := t.TempDir()
	writeRuntimeFixture(t, directory, ModeProcess)
	protected := filepath.Join(directory, "protected.txt")
	if err := os.WriteFile(protected, []byte("do not delete\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := newFakeProvider(ModeProcess)
	manager := newTestManager(t, directory, provider)
	ctx := context.Background()

	results := make(chan Result, 2)
	errors := make(chan error, 2)
	for range 2 {
		go func() {
			result, err := manager.Start(ctx, directory, OperationOptions{}, Streams{Out: io.Discard, Err: io.Discard})
			results <- result
			errors <- err
		}()
	}
	first := <-results
	second := <-results
	firstErr := <-errors
	secondErr := <-errors
	if firstErr != nil || secondErr != nil {
		provider.mu.Lock()
		defer provider.mu.Unlock()
		t.Fatalf("concurrent starts failed: %v / %v; starts=%d exists=%v handle=%#v results=%#v/%#v", firstErr, secondErr, provider.startCount, provider.exists, provider.handle, first, second)
	}
	if first.Generation != second.Generation || provider.startCount != 1 {
		t.Fatalf("duplicate start created multiple runtimes: generations %q/%q, starts %d", first.Generation, second.Generation, provider.startCount)
	}

	suspended, err := manager.Suspend(ctx, directory, OperationOptions{ExpectedGeneration: first.Generation})
	if err != nil || suspended.State != StateSuspended {
		t.Fatalf("suspend = %#v, %v", suspended, err)
	}
	inspected, err := manager.Inspect(ctx, directory, OperationOptions{ExpectedGeneration: first.Generation})
	if err != nil || inspected.State != StateSuspended {
		t.Fatalf("inspect suspended = %#v, %v", inspected, err)
	}
	resumed, err := manager.Resume(ctx, directory, OperationOptions{ExpectedGeneration: first.Generation})
	if err != nil || resumed.State != StateRunning {
		t.Fatalf("resume = %#v, %v", resumed, err)
	}
	stopped, err := manager.Stop(ctx, directory, OperationOptions{ExpectedGeneration: first.Generation}, Streams{Out: io.Discard, Err: io.Discard})
	if err != nil || stopped.State != StateStopped {
		t.Fatalf("stop = %#v, %v", stopped, err)
	}
	if _, err := manager.Clean(ctx, directory, OperationOptions{ExpectedGeneration: first.Generation}); err != nil {
		t.Fatalf("clean: %v", err)
	}
	body, err := os.ReadFile(protected)
	if err != nil || string(body) != "do not delete\n" {
		t.Fatalf("clean changed checkout: %q, %v", body, err)
	}
	third, err := manager.Start(ctx, directory, OperationOptions{}, Streams{Out: io.Discard, Err: io.Discard})
	if err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if third.Generation == first.Generation || third.WorkspaceID != first.WorkspaceID {
		t.Fatalf("recreation identity = %#v, first = %#v", third, first)
	}
}

func TestContainerProviderUsesSameLifecycleAndRejectsForeignEvidence(t *testing.T) {
	directory := t.TempDir()
	writeRuntimeFixture(t, directory, ModeDevcontainer)
	provider := newFakeProvider(ModeDevcontainer)
	manager := newTestManager(t, directory, provider)
	result, err := manager.Start(context.Background(), directory, OperationOptions{}, Streams{Out: io.Discard, Err: io.Discard})
	if err != nil || result.State != StateRunning {
		t.Fatalf("container start = %#v, %v", result, err)
	}
	provider.mu.Lock()
	provider.foreign = true
	provider.mu.Unlock()
	if _, err := manager.Stop(context.Background(), directory, OperationOptions{ExpectedGeneration: result.Generation}, Streams{}); err == nil {
		t.Fatal("foreign container evidence was accepted")
	}
	provider.mu.Lock()
	if provider.stopCount != 0 {
		t.Fatalf("foreign container was stopped %d times", provider.stopCount)
	}
	provider.mu.Unlock()
}

func TestExpectedWorkspaceIDFailsBeforeRuntimeMutation(t *testing.T) {
	directory := t.TempDir()
	writeRuntimeFixture(t, directory, ModeProcess)
	provider := newFakeProvider(ModeProcess)
	manager := newTestManager(t, directory, provider)
	_, err := manager.Start(context.Background(), directory, OperationOptions{
		ExpectedWorkspaceID: "123e4567-e89b-42d3-a456-426614174099",
	}, Streams{})
	if err == nil || !strings.Contains(err.Error(), "Workspace identity mismatch") {
		t.Fatalf("mismatched Workspace identity error = %v", err)
	}
	if provider.startCount != 0 {
		t.Fatalf("mismatched Workspace identity started %d runtimes", provider.startCount)
	}
}

func TestExpectedBranchFailsBeforeRuntimeMutation(t *testing.T) {
	directory := t.TempDir()
	writeRuntimeFixture(t, directory, ModeProcess)
	provider := newFakeProvider(ModeProcess)
	manager := newTestManager(t, directory, provider)
	_, err := manager.Start(context.Background(), directory, OperationOptions{
		ExpectedBranch: "different-branch",
	}, Streams{})
	if err == nil || !strings.Contains(err.Error(), "Workspace branch mismatch") {
		t.Fatalf("mismatched Workspace branch error = %v", err)
	}
	if provider.startCount != 0 {
		t.Fatalf("mismatched Workspace branch started %d runtimes", provider.startCount)
	}
}

func TestTrustedControlPlaneCanPreallocateRuntimeGeneration(t *testing.T) {
	directory := t.TempDir()
	writeRuntimeFixture(t, directory, ModeProcess)
	provider := newFakeProvider(ModeProcess)
	manager := newTestManager(t, directory, provider)
	const generation = "123e4567-e89b-42d3-a456-426614174000"
	result, err := manager.Start(context.Background(), directory, OperationOptions{
		ExpectedGeneration: generation,
	}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Generation != generation {
		t.Fatalf("preallocated generation = %#v", result)
	}
}

type fakeIdentityResolver struct{ identity WorkspaceIdentity }

func (resolver fakeIdentityResolver) Resolve(context.Context, string) (WorkspaceIdentity, error) {
	return resolver.identity, nil
}

type allowCheckout struct{}

func (allowCheckout) Verify(context.Context, WorkspaceIdentity, OperationOptions) error { return nil }

type fakeVerifier struct{}

func (fakeVerifier) Verify(context.Context, Manifest) (VerifiedTools, error) {
	return VerifiedTools{ProjectBinary: "/fixture/project", CodexBinary: "/fixture/codex"}, nil
}

type fakeProjectLifecycle struct{}

func (fakeProjectLifecycle) PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error) {
	return projectrun.SetupCollectionResult{}, nil
}
func (fakeProjectLifecycle) RunWithOptions(context.Context, string, string, projectrun.Streams, projectrun.RunOptions) (projectrun.RunResult, error) {
	return projectrun.RunResult{}, nil
}
func (fakeProjectLifecycle) StartWithOptions(context.Context, string, string, projectrun.StartOptions) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, fmt.Errorf("unexpected dev-server start")
}
func (fakeProjectLifecycle) ObserveSessions(context.Context) (projectrun.ServeCollectionResult, error) {
	return projectrun.ServeCollectionResult{Sessions: []projectrun.ServeResult{}}, nil
}
func (fakeProjectLifecycle) Status(context.Context, string, string) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, fmt.Errorf("unexpected dev-server status")
}
func (fakeProjectLifecycle) StopExpected(context.Context, string, string, string, string) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, fmt.Errorf("unexpected dev-server stop")
}

type fakeProvider struct {
	mu         sync.Mutex
	mode       Mode
	exists     bool
	suspended  bool
	foreign    bool
	startCount int
	stopCount  int
	handle     RuntimeHandle
}

func newFakeProvider(mode Mode) *fakeProvider { return &fakeProvider{mode: mode} }
func (provider *fakeProvider) Mode() Mode     { return provider.mode }

func (provider *fakeProvider) Start(_ context.Context, request LaunchRequest) (RuntimeHandle, error) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.startCount++
	if provider.mode == ModeProcess {
		provider.handle = RuntimeHandle{Kind: ResourceProcess, Process: &ProcessHandle{PID: 12345, Identity: repeated("c"), BindingDigest: bindingDigest(request.Binding), AppServerSocket: appServerSocketPath(request.Binding)}}
	} else {
		provider.handle = RuntimeHandle{Kind: ResourceContainer, Container: &ContainerHandle{
			Provider: "fixture", ContainerID: "container-1", ImageDigest: repeated("d"), Binding: request.Binding,
		}}
	}
	if err := request.Commit(provider.handle); err != nil {
		return RuntimeHandle{}, err
	}
	provider.exists = true
	return provider.handle, nil
}

func (provider *fakeProvider) Inspect(_ context.Context, handle RuntimeHandle, _ RuntimeBinding) (ProviderObservation, error) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	owned := !provider.foreign && reflect.DeepEqual(handle, provider.handle)
	return ProviderObservation{Exists: provider.exists, Owned: owned, Running: provider.exists && !provider.suspended, Suspended: provider.exists && provider.suspended, Handle: handle}, nil
}
func (provider *fakeProvider) Suspend(context.Context, RuntimeHandle, RuntimeBinding) error {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.suspended = true
	return nil
}
func (provider *fakeProvider) Resume(context.Context, RuntimeHandle, RuntimeBinding) error {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.suspended = false
	return nil
}
func (provider *fakeProvider) Stop(context.Context, RuntimeHandle, RuntimeBinding, time.Duration) error {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.stopCount++
	provider.exists = false
	provider.suspended = false
	return nil
}
func (provider *fakeProvider) Clean(context.Context, RuntimeHandle, RuntimeBinding) error { return nil }

func newTestManager(t *testing.T, directory string, provider RuntimeProvider) *Manager {
	t.Helper()
	identity := WorkspaceIdentity{
		WorkspaceID: "ws_" + repeatedN("a", 24), Repository: filepath.Join(directory, ".git-common"),
		Directory: directory, GitDirectory: filepath.Join(directory, ".git-worktree"), Branch: "issue-fixture",
		Head: repeated("e")[:40], IdentityProof: repeated("f"), Owner: "019ff2a1-7f21-7f22-98c9-f47c47b4238b",
	}
	tokens := []string{
		"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
		"33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
	}
	var tokenMu sync.Mutex
	manager, err := NewManager(Dependencies{
		StateRoot: t.TempDir(), Identity: fakeIdentityResolver{identity: identity}, Checkout: allowCheckout{},
		Project: fakeProjectLifecycle{}, Providers: []RuntimeProvider{provider}, Verifier: fakeVerifier{},
		Now: func() time.Time { return time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC) },
		Token: func() (string, error) {
			tokenMu.Lock()
			defer tokenMu.Unlock()
			if len(tokens) == 0 {
				return "", fmt.Errorf("token fixture exhausted")
			}
			value := tokens[0]
			tokens = tokens[1:]
			return value, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func repeated(value string) string { return repeatedN(value, 64) }
func repeatedN(value string, count int) string {
	result := ""
	for range count {
		result += value
	}
	return result
}
