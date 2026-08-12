package workspacerun

import (
	"context"
	"errors"
	"fmt"
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
	helper, err := buildProjectFixture(t.TempDir(), filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	codex, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("Codex CLI is not installed")
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
	stateRoot := t.TempDir()
	openManager := func() (*Manager, error) {
		return NewManager(Dependencies{
			StateRoot: stateRoot, Identity: lifecycleIdentityResolver{identity: identity},
			Checkout: lifecycleAllowCheckout{}, Project: &lifecycleProject{},
			Providers: []RuntimeProvider{ProcessProvider{}},
			Verifier:  fixedProjectVerifier{project: helper, codex: codex}, Now: time.Now,
			Token: randomToken,
		})
	}
	manager, err := openManager()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	started, err := manager.Start(ctx, workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	t.Cleanup(func() {
		if started.Generation == "" {
			return
		}
		cleanupManager, openErr := openManager()
		if openErr != nil {
			return
		}
		_, _ = cleanupManager.Stop(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation}, Streams{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.State != StateRunning || started.PID == nil {
		t.Fatalf("start = %#v", started)
	}
	manager, err = openManager()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Inspect(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil {
		t.Fatal(err)
	}
	manager, err = openManager()
	if err != nil {
		t.Fatal(err)
	}
	if result, err := manager.Suspend(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil || result.State != StateSuspended {
		t.Fatalf("suspend = %#v, %v", result, err)
	}
	manager, err = openManager()
	if err != nil {
		t.Fatal(err)
	}
	if result, err := manager.Resume(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil || result.State != StateRunning {
		t.Fatalf("resume = %#v, %v", result, err)
	}
	manager, err = openManager()
	if err != nil {
		t.Fatal(err)
	}
	if result, err := manager.Stop(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}, Streams{}); err != nil || result.State != StateStopped {
		t.Fatalf("stop = %#v, %v", result, err)
	}
	if err := syscall.Kill(neighbor.Process.Pid, 0); err != nil {
		t.Fatalf("neighboring process was changed: %v", err)
	}
	manager, err = openManager()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Clean(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil {
		t.Fatal(err)
	}
	manager, err = openManager()
	if err != nil {
		t.Fatal(err)
	}
	if replayed, err := manager.Clean(ctx, workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil || replayed.Disposition != DispositionCleaned {
		t.Fatalf("replayed clean = %#v, %v", replayed, err)
	}
	if _, err := os.Stat(filepath.Join(workspace, manifestPath)); err != nil {
		t.Fatalf("clean removed checkout content: %v", err)
	}
}

func TestProjectFixtureBuildCleansItsTemporaryDirectoryAfterFailure(t *testing.T) {
	root := t.TempDir()
	if _, err := buildProjectFixture(root, filepath.Join(root, "missing-repository")); err == nil {
		t.Fatal("fixture build unexpectedly succeeded")
	}
	if _, err := os.Stat(filepath.Join(root, "go-build")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("task-owned Go build directory remains after failure: %v", err)
	}
}

func buildProjectFixture(root, repository string) (_ string, returnErr error) {
	buildRoot := filepath.Join(root, "go-build")
	if err := os.MkdirAll(buildRoot, 0o700); err != nil {
		return "", fmt.Errorf("create task-owned Go build directory: %w", err)
	}
	defer func() {
		returnErr = errors.Join(returnErr, os.RemoveAll(buildRoot))
	}()
	helper := filepath.Join(root, "project")
	build := exec.Command("go", "build", "-o", helper, "./cmd/project")
	build.Dir = repository
	build.Env = append(os.Environ(),
		"GOTMPDIR="+buildRoot,
		"TEMP="+buildRoot,
		"TMP="+buildRoot,
		"TMPDIR="+buildRoot,
	)
	if output, err := build.CombinedOutput(); err != nil {
		return "", fmt.Errorf("build Project CLI fixture: %w\n%s", err, output)
	}
	return helper, nil
}

type fixedProjectVerifier struct{ project, codex string }

func (verifier fixedProjectVerifier) Verify(context.Context, Manifest) (VerifiedTools, error) {
	return VerifiedTools{ProjectBinary: verifier.project, CodexBinary: verifier.codex}, nil
}
