package workspacerun

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestRealProcessRuntimeLifecyclePreservesNeighborAndCheckout(t *testing.T) {
	if testing.Short() {
		t.Skip("real process lifecycle is an integration check")
	}
	workspace := t.TempDir()
	writeRuntimeFixture(t, workspace, ModeProcess)
	helper := filepath.Join(t.TempDir(), "project")
	build := exec.Command("go", "build", "-o", helper, "./cmd/project")
	build.Dir = filepath.Join("..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build Project CLI fixture: %v\n%s", err, output)
	}
	neighbor := exec.Command("sleep", "30")
	if err := neighbor.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = neighbor.Process.Kill()
		_, _ = neighbor.Process.Wait()
	})

	identity := lifecycleWorkspaceIdentity(workspace)
	tokens := []string{
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
	}
	manager, err := NewManager(Dependencies{
		StateRoot: t.TempDir(), Identity: lifecycleIdentityResolver{identity: identity},
		Checkout: lifecycleAllowCheckout{}, Project: &lifecycleProject{},
		Providers: []RuntimeProvider{ProcessProvider{}},
		Verifier:  fixedProjectVerifier{path: helper}, Now: time.Now,
		Token: func() (string, error) {
			value := tokens[0]
			tokens = tokens[1:]
			return value, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	started, err := manager.Start(ctx, workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	if started.State != StateRunning || started.PID == nil {
		t.Fatalf("start = %#v", started)
	}
	if _, err := manager.Inspect(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil {
		t.Fatal(err)
	}
	if result, err := manager.Suspend(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil || result.State != StateSuspended {
		t.Fatalf("suspend = %#v, %v", result, err)
	}
	if result, err := manager.Resume(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil || result.State != StateRunning {
		t.Fatalf("resume = %#v, %v", result, err)
	}
	if result, err := manager.Stop(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}, Streams{}); err != nil || result.State != StateStopped {
		t.Fatalf("stop = %#v, %v", result, err)
	}
	if err := syscall.Kill(neighbor.Process.Pid, 0); err != nil {
		t.Fatalf("neighboring process was changed: %v", err)
	}
	if _, err := manager.Clean(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(workspace, manifestPath)); err != nil {
		t.Fatalf("clean removed checkout content: %v", err)
	}
}

type fixedProjectVerifier struct{ path string }

func (verifier fixedProjectVerifier) Verify(context.Context, Manifest) (VerifiedTools, error) {
	return VerifiedTools{ProjectBinary: verifier.path}, nil
}
