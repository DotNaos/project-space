//go:build windows

package machineconnect

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const (
	windowsLifetimeHelperModeEnvironment = "PROJECT_SPACE_TEST_WINDOWS_LIFETIME_HELPER"
	windowsLifetimeLockPathEnvironment   = "PROJECT_SPACE_TEST_WINDOWS_LIFETIME_LOCK"
	windowsLifetimePIDPathEnvironment    = "PROJECT_SPACE_TEST_WINDOWS_LIFETIME_PID"
)

func TestWindowsConnectorSupervisorLifetimeSingletonFailsClosed(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "connector.runtime.lock")
	ownerStore := &supervisorTestStore{runtimeLockPath: lockPath}
	owner, err := newConnectorSupervisorLifetime(ownerStore)
	if err != nil {
		t.Fatalf("acquire first connector runtime lifetime: %v", err)
	}
	t.Cleanup(func() {
		_ = owner.Close()
	})

	contenderStore := &supervisorTestStore{
		credential:      supervisorCredential(t),
		runtimeLockPath: lockPath,
	}
	supervisor, err := NewConnectorSupervisor(contenderStore, ConnectorSupervisorOptions{
		Executable: filepath.Join(t.TempDir(), "must-not-start.exe"),
		Stdout:     io.Discard,
		Stderr:     io.Discard,
	})
	if err != nil {
		t.Fatalf("create competing connector supervisor: %v", err)
	}
	err = supervisor.Run(t.Context())
	if !errors.Is(err, ErrConnectorRuntimeAlreadyRunning) {
		t.Fatalf("competing connector runtime error = %v, want singleton rejection", err)
	}
	if contenderStore.loadCalls != 0 {
		t.Fatalf("competing connector loaded its credential %d times before singleton rejection", contenderStore.loadCalls)
	}

	if err := owner.Close(); err != nil {
		t.Fatalf("release first connector runtime lifetime: %v", err)
	}
	replacement, err := newConnectorSupervisorLifetime(ownerStore)
	if err != nil {
		t.Fatalf("reacquire connector runtime lifetime after release: %v", err)
	}
	if err := replacement.Close(); err != nil {
		t.Fatalf("release replacement connector runtime lifetime: %v", err)
	}
}

func TestWindowsCredentialRuntimeBarrierWaitsForSupervisorExit(t *testing.T) {
	store := newTestWindowsDPAPIStore(t)
	owner, err := newConnectorSupervisorLifetime(store)
	if err != nil {
		t.Fatalf("acquire connector runtime lifetime: %v", err)
	}

	blockedCtx, cancelBlocked := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancelBlocked()
	if release, err := store.LockConnectorRuntime(blockedCtx); !errors.Is(err, context.DeadlineExceeded) {
		if release != nil {
			_ = release()
		}
		t.Fatalf("runtime barrier error = %v, want deadline while supervisor is active", err)
	}
	if err := owner.Close(); err != nil {
		t.Fatalf("release connector runtime lifetime: %v", err)
	}

	release, err := store.LockConnectorRuntime(context.Background())
	if err != nil {
		t.Fatalf("acquire runtime barrier after supervisor exit: %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("release runtime barrier: %v", err)
	}
}

func TestWindowsConnectorSupervisorLifetimeKillsChildWhenOwnerTerminates(t *testing.T) {
	temporaryDirectory := t.TempDir()
	lockPath := filepath.Join(temporaryDirectory, "connector.runtime.lock")
	pidPath := filepath.Join(temporaryDirectory, "child.pid")

	var helperOutput bytes.Buffer
	owner := exec.Command(os.Args[0], "-test.run=^TestWindowsConnectorSupervisorLifetimeHelper$")
	owner.Env = windowsLifetimeHelperEnvironment("owner", lockPath, pidPath)
	owner.Stdout = &helperOutput
	owner.Stderr = &helperOutput
	if err := owner.Start(); err != nil {
		t.Fatalf("start connector owner helper: %v", err)
	}
	ownerWaited := false
	t.Cleanup(func() {
		if !ownerWaited {
			_ = owner.Process.Kill()
			_ = owner.Wait()
		}
	})

	childPID, err := waitForWindowsLifetimeHelperPID(pidPath, 10*time.Second)
	if err != nil {
		t.Fatalf("wait for attached connector child: %v; helper output: %s", err, helperOutput.String())
	}
	childHandle, err := windows.OpenProcess(
		windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false,
		uint32(childPID),
	)
	if err != nil {
		t.Fatalf("open attached connector child: %v", err)
	}
	defer windows.CloseHandle(childHandle)

	if err := owner.Process.Kill(); err != nil {
		t.Fatalf("terminate connector owner helper: %v", err)
	}
	if err := owner.Wait(); err == nil {
		t.Fatal("connector owner helper unexpectedly exited successfully after termination")
	}
	ownerWaited = true

	waitResult, err := windows.WaitForSingleObject(childHandle, 10_000)
	if err != nil {
		t.Fatalf("wait for attached connector child termination: %v", err)
	}
	if waitResult != windows.WAIT_OBJECT_0 {
		t.Fatalf("attached connector child remained alive after owner termination; wait result = %#x", waitResult)
	}
}

func TestWindowsConnectorSupervisorLifetimeHelper(t *testing.T) {
	switch os.Getenv(windowsLifetimeHelperModeEnvironment) {
	case "":
		return
	case "child":
		time.Sleep(time.Hour)
		t.Fatal("connector child helper sleep ended unexpectedly")
	case "owner":
		runWindowsConnectorLifetimeOwnerHelper(t)
	default:
		t.Fatal("unknown Windows connector lifetime helper mode")
	}
}

func runWindowsConnectorLifetimeOwnerHelper(t *testing.T) {
	t.Helper()
	lockPath := os.Getenv(windowsLifetimeLockPathEnvironment)
	pidPath := os.Getenv(windowsLifetimePIDPathEnvironment)
	if lockPath == "" || pidPath == "" {
		t.Fatal("Windows connector lifetime helper paths are missing")
	}

	lifetime, err := newConnectorSupervisorLifetime(&supervisorTestStore{runtimeLockPath: lockPath})
	if err != nil {
		t.Fatalf("create connector lifetime: %v", err)
	}
	defer lifetime.Close()

	child := exec.Command(os.Args[0], "-test.run=^TestWindowsConnectorSupervisorLifetimeHelper$")
	child.Env = windowsLifetimeHelperEnvironment("child", "", "")
	child.Stdout = io.Discard
	child.Stderr = io.Discard
	if err := child.Start(); err != nil {
		t.Fatalf("start connector child helper: %v", err)
	}
	if err := lifetime.Attach(child.Process); err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatalf("attach connector child helper: %v", err)
	}
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatalf("publish connector child helper PID: %v", err)
	}

	time.Sleep(time.Hour)
	t.Fatal("connector owner helper sleep ended unexpectedly")
}

func waitForWindowsLifetimeHelperPID(path string, timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		body, err := os.ReadFile(path)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(body)))
			if parseErr == nil && pid > 0 {
				return pid, nil
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	return 0, fmt.Errorf("PID was not published within %s", timeout)
}

func windowsLifetimeHelperEnvironment(mode, lockPath, pidPath string) []string {
	keys := map[string]struct{}{
		strings.ToUpper(windowsLifetimeHelperModeEnvironment): {},
		strings.ToUpper(windowsLifetimeLockPathEnvironment):   {},
		strings.ToUpper(windowsLifetimePIDPathEnvironment):    {},
	}
	environment := make([]string, 0, len(os.Environ())+3)
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if _, excluded := keys[strings.ToUpper(name)]; !excluded {
			environment = append(environment, entry)
		}
	}
	environment = append(environment, windowsLifetimeHelperModeEnvironment+"="+mode)
	if lockPath != "" {
		environment = append(environment, windowsLifetimeLockPathEnvironment+"="+lockPath)
	}
	if pidPath != "" {
		environment = append(environment, windowsLifetimePIDPathEnvironment+"="+pidPath)
	}
	return environment
}
