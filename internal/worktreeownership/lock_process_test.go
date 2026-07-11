package worktreeownership

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const lockHelperEnvironment = "PROJECT_WORKTREE_LOCK_HELPER"

func TestOwnershipLockSerializesProcesses(t *testing.T) {
	mainPath := setupRepository(t)
	stateDirectory := t.TempDir()
	lockedMarker := filepath.Join(stateDirectory, "locked")
	releaseMarker := filepath.Join(stateDirectory, "release")
	output := &bytes.Buffer{}
	helper := exec.Command(os.Args[0], "-test.run=^TestOwnershipLockHelper$")
	helper.Env = append(os.Environ(),
		lockHelperEnvironment+"=1",
		"PROJECT_WORKTREE_LOCK_REPO="+mainPath,
		"PROJECT_WORKTREE_LOCK_MARKER="+lockedMarker,
		"PROJECT_WORKTREE_LOCK_RELEASE="+releaseMarker,
	)
	helper.Stdout = output
	helper.Stderr = output
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	released := false
	t.Cleanup(func() {
		if !released {
			_ = os.WriteFile(releaseMarker, []byte("release\n"), 0o600)
		}
		_ = helper.Wait()
	})
	waitForPath(t, lockedMarker, 5*time.Second)

	second := make(chan error, 1)
	go func() {
		second <- withOwnershipLock(mainPath, func() error { return nil })
	}()
	select {
	case err := <-second:
		t.Fatalf("second process bypassed the lock: %v", err)
	case <-time.After(150 * time.Millisecond):
	}

	if err := os.WriteFile(releaseMarker, []byte("release\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	released = true
	if err := helper.Wait(); err != nil {
		t.Fatalf("lock helper failed: %v\n%s", err, output.String())
	}
	select {
	case err := <-second:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second process did not acquire the released lock")
	}
}

func TestOwnershipLockHelper(t *testing.T) {
	if os.Getenv(lockHelperEnvironment) != "1" {
		return
	}
	repo := os.Getenv("PROJECT_WORKTREE_LOCK_REPO")
	marker := os.Getenv("PROJECT_WORKTREE_LOCK_MARKER")
	release := os.Getenv("PROJECT_WORKTREE_LOCK_RELEASE")
	err := withOwnershipLock(repo, func() error {
		if err := os.WriteFile(marker, []byte("locked\n"), 0o600); err != nil {
			return err
		}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(release); err == nil {
				return nil
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			time.Sleep(10 * time.Millisecond)
		}
		return errors.New("timed out waiting for lock release marker")
	})
	if err != nil {
		t.Fatal(err)
	}
}

func waitForPath(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}
