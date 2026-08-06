package machineconnect

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDefaultCodexOperationSnapshotPathIsBesideMachineCredential(t *testing.T) {
	credential, err := DefaultCredentialPath()
	if err != nil {
		t.Fatalf("resolve default credential path: %v", err)
	}
	snapshot, err := DefaultCodexOperationSnapshotPath()
	if err != nil {
		t.Fatalf("resolve default Codex operation snapshot path: %v", err)
	}
	want := filepath.Join(filepath.Dir(credential), CodexOperationSnapshotFilename)
	if snapshot != want {
		t.Fatalf("default Codex operation snapshot path = %q, want %q", snapshot, want)
	}
}

func TestCredentialValidationAllowsPortlessLocalhostBackend(t *testing.T) {
	credential := testCredential(time.Now().UTC())
	credential.BackendURL = "http://project-space.localhost:1355"

	if err := validateCredential(credential); err != nil {
		t.Fatalf("expected Portless localhost credential to be valid, got %v", err)
	}
}

func TestFileStorePersistsCredentialWithPrivatePermissions(t *testing.T) {
	requirePrivateFileCredentialStore(t)
	directory := filepath.Join(t.TempDir(), "nested", "project-space")
	path := filepath.Join(directory, "machine-credential.json")
	store, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	credential := testCredential(time.Now().UTC())
	key := testMachineKey(t)
	if err := store.SaveKey(key); err != nil {
		t.Fatalf("save key: %v", err)
	}
	if err := store.Save(credential); err != nil {
		t.Fatalf("save: %v", err)
	}

	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat credential: %v", err)
	}
	if permissions := fileInfo.Mode().Perm(); permissions != 0o600 {
		t.Fatalf("credential permissions = %o, want 600", permissions)
	}
	directoryInfo, err := os.Stat(directory)
	if err != nil {
		t.Fatalf("stat directory: %v", err)
	}
	if permissions := directoryInfo.Mode().Perm(); permissions != 0o700 {
		t.Fatalf("directory permissions = %o, want 700", permissions)
	}

	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.Token != credential.Token || loaded.MachineID != credential.MachineID {
		t.Fatalf("loaded credential mismatch: %#v", loaded)
	}
	if err := store.Delete(); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("expected missing credential after delete, got %v", err)
	}
	if _, err := store.LoadKey(); err != nil {
		t.Fatalf("machine key was deleted with credential: %v", err)
	}
	staleTemporary := filepath.Join(directory, machineCredentialTemporaryFilePrefix+"stale")
	if err := os.WriteFile(staleTemporary, []byte("stale sensitive state"), 0o600); err != nil {
		t.Fatalf("seed stale temporary identity: %v", err)
	}
	unrelated := filepath.Join(directory, "keep-me")
	if err := os.WriteFile(unrelated, []byte("unrelated"), 0o600); err != nil {
		t.Fatalf("seed unrelated file: %v", err)
	}
	if err := store.Purge(); err != nil {
		t.Fatalf("purge machine identity: %v", err)
	}
	if err := store.Purge(); err != nil {
		t.Fatalf("idempotent purge machine identity: %v", err)
	}
	if _, err := store.LoadKey(); !errors.Is(err, ErrMachineKeyNotFound) {
		t.Fatalf("load key after purge = %v, want machine key not found", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("credential state remains after purge: %v", err)
	}
	if _, err := os.Stat(staleTemporary); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale temporary identity remains after purge: %v", err)
	}
	if body, err := os.ReadFile(unrelated); err != nil || string(body) != "unrelated" {
		t.Fatalf("purge changed unrelated file: body=%q error=%v", body, err)
	}
}

func TestFileStorePurgeRejectsSymlinkedParentAndTemporaryState(t *testing.T) {
	requirePrivateFileCredentialStore(t)
	root := t.TempDir()
	targetDirectory := filepath.Join(root, "target")
	if err := os.Mkdir(targetDirectory, 0o700); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	linkedDirectory := filepath.Join(root, "linked")
	if err := os.Symlink(targetDirectory, linkedDirectory); err != nil {
		t.Skipf("create directory symlink: %v", err)
	}
	sentinel := filepath.Join(targetDirectory, "machine-credential.json")
	if err := os.WriteFile(sentinel, []byte("do not remove"), 0o600); err != nil {
		t.Fatalf("write sentinel: %v", err)
	}
	store, err := NewFileStore(filepath.Join(linkedDirectory, "machine-credential.json"))
	if err != nil {
		t.Fatalf("new linked store: %v", err)
	}
	if err := store.Purge(); err == nil {
		t.Fatal("purge through symlinked parent unexpectedly succeeded")
	}
	if body, err := os.ReadFile(sentinel); err != nil || string(body) != "do not remove" {
		t.Fatalf("purge changed symlink target: body=%q error=%v", body, err)
	}

	directStore, err := NewFileStore(filepath.Join(targetDirectory, "owned.json"))
	if err != nil {
		t.Fatalf("new direct store: %v", err)
	}
	outside := filepath.Join(root, "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatalf("write outside sentinel: %v", err)
	}
	temporaryLink := filepath.Join(targetDirectory, machineCredentialTemporaryFilePrefix+"link")
	if err := os.Symlink(outside, temporaryLink); err != nil {
		t.Skipf("create temporary symlink: %v", err)
	}
	if err := directStore.Purge(); err == nil {
		t.Fatal("purge accepted a temporary identity symlink")
	}
	if body, err := os.ReadFile(outside); err != nil || string(body) != "outside" {
		t.Fatalf("purge changed temporary symlink target: body=%q error=%v", body, err)
	}
}

func TestFileStoreRefusesCredentialSymlink(t *testing.T) {
	requirePrivateFileCredentialStore(t)
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	if err := os.WriteFile(target, []byte("do not replace"), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	path := filepath.Join(directory, "machine-credential.json")
	if err := os.Symlink(target, path); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	store, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if err := store.SaveKey(testMachineKey(t)); err == nil {
		t.Fatal("expected symlink save to fail")
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(body) != "do not replace" {
		t.Fatalf("symlink target was modified: %q", body)
	}
}

func TestFileStoreRepairsPermissiveCredentialMode(t *testing.T) {
	requirePrivateFileCredentialStore(t)
	path := filepath.Join(t.TempDir(), "machine-credential.json")
	store, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if err := store.SaveKey(testMachineKey(t)); err != nil {
		t.Fatalf("save key: %v", err)
	}
	if err := store.Save(testCredential(time.Now().UTC())); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("make mode permissive: %v", err)
	}
	if _, err := store.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if permissions := info.Mode().Perm(); permissions != 0o600 {
		t.Fatalf("credential permissions = %o, want 600", permissions)
	}
}

func TestFileStoreRefusesSymlinkCredentialDirectory(t *testing.T) {
	requirePrivateFileCredentialStore(t)
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	directory := filepath.Join(root, "credential-directory")
	if err := os.Symlink(target, directory); err != nil {
		t.Fatalf("create directory symlink: %v", err)
	}
	store, err := NewFileStore(filepath.Join(directory, "machine-credential.json"))
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if err := store.SaveKey(testMachineKey(t)); err == nil {
		t.Fatal("expected symlink credential directory to be rejected")
	}
	if _, err := os.Stat(filepath.Join(target, "machine-credential.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("credential was written through directory symlink: %v", err)
	}
}

func TestFileStoreRejectsOversizedStateBeforeDecoding(t *testing.T) {
	requirePrivateFileCredentialStore(t)
	path := filepath.Join(t.TempDir(), "machine-credential.json")
	if err := os.WriteFile(path, make([]byte, maximumLocalMachineStateBytes+1), 0o600); err != nil {
		t.Fatalf("write oversized state: %v", err)
	}
	store, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if _, err := store.LoadKey(); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("load oversized state error = %v, want bounded failure", err)
	}
}

func TestCredentialValidationRejectsControlCharactersAndUnboundedOrigins(t *testing.T) {
	credential := testCredential(time.Now().UTC())
	for name, mutate := range map[string]func(*Credential){
		"machine newline": func(value *Credential) { value.MachineName = "trusted\nforged" },
		"machine tab":     func(value *Credential) { value.MachineName = "trusted\tforged" },
		"origin spaces":   func(value *Credential) { value.BackendURL = " https://projects.os-home.net" },
		"origin too long": func(value *Credential) { value.BackendURL = "https://" + strings.Repeat("x", 4096) },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := credential
			mutate(&candidate)
			if err := validateCredential(candidate); err == nil {
				t.Fatal("expected credential to be rejected")
			}
		})
	}
}

func TestFileStoreLockSerializesIndependentStoreInstances(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machine-credential.json")
	first, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("new first store: %v", err)
	}
	second, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("new second store: %v", err)
	}

	releaseFirst, err := first.Lock(context.Background())
	if err != nil {
		t.Fatalf("lock first store: %v", err)
	}
	acquired := make(chan func() error, 1)
	errorsFromSecond := make(chan error, 1)
	go func() {
		release, lockErr := second.Lock(context.Background())
		if lockErr != nil {
			errorsFromSecond <- lockErr
			return
		}
		acquired <- release
	}()

	select {
	case release := <-acquired:
		_ = release()
		t.Fatal("second store acquired the lock before the first released it")
	case lockErr := <-errorsFromSecond:
		t.Fatalf("second store lock failed: %v", lockErr)
	case <-time.After(100 * time.Millisecond):
	}

	if err := releaseFirst(); err != nil {
		t.Fatalf("release first store: %v", err)
	}
	select {
	case release := <-acquired:
		if err := release(); err != nil {
			t.Fatalf("release second store: %v", err)
		}
	case lockErr := <-errorsFromSecond:
		t.Fatalf("second store lock failed: %v", lockErr)
	case <-time.After(2 * time.Second):
		t.Fatal("second store did not acquire the lock after release")
	}
}

func TestFileStoreLockSerializesSeparateProcesses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machine-credential.json")
	store, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	release, err := store.Lock(context.Background())
	if err != nil {
		t.Fatalf("lock parent store: %v", err)
	}

	runLockHelper(t, path, "blocked")
	if err := release(); err != nil {
		t.Fatalf("release parent store: %v", err)
	}
	runLockHelper(t, path, "acquired")
}

func TestFileStoreLockProcessHelper(t *testing.T) {
	expectation := os.Getenv("PROJECT_SPACE_TEST_LOCK_HELPER")
	if expectation == "" {
		t.Skip("subprocess helper")
	}
	store, err := NewFileStore(os.Getenv("PROJECT_SPACE_TEST_LOCK_PATH"))
	if err != nil {
		t.Fatalf("new helper store: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	release, lockErr := store.Lock(ctx)
	if expectation == "blocked" {
		if !errors.Is(lockErr, context.DeadlineExceeded) {
			t.Fatalf("helper lock error = %v, want deadline exceeded", lockErr)
		}
		return
	}
	if lockErr != nil {
		t.Fatalf("helper lock after release: %v", lockErr)
	}
	if err := release(); err != nil {
		t.Fatalf("release helper store: %v", err)
	}
}

func runLockHelper(t *testing.T, path string, expectation string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestFileStoreLockProcessHelper$")
	command.Env = append(
		os.Environ(),
		"PROJECT_SPACE_TEST_LOCK_HELPER="+expectation,
		"PROJECT_SPACE_TEST_LOCK_PATH="+path,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("lock helper %s failed: %v\n%s", expectation, err, output)
	}
}

func TestFileCredentialStateIsExplicitlyUnsupportedOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows-only safety contract")
	}
	store, err := NewFileStore(filepath.Join(t.TempDir(), "machine-credential.json"))
	if err != nil {
		t.Fatalf("new file store: %v", err)
	}
	if err := store.SaveKey(testMachineKey(t)); !errors.Is(err, ErrFileCredentialStoreUnsupported) {
		t.Fatalf("save key error = %v, want unsupported file credential store", err)
	}
}

func requirePrivateFileCredentialStore(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("native Windows credentials use a DPAPI-protected store, not POSIX file modes")
	}
}
