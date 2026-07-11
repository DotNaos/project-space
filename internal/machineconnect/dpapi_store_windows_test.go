//go:build windows

package machineconnect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

var (
	_ CredentialStore        = (*windowsDPAPICredentialStore)(nil)
	_ CredentialLocker       = (*windowsDPAPICredentialStore)(nil)
	_ CredentialPurger       = (*windowsDPAPICredentialStore)(nil)
	_ ConnectorRuntimeLocker = (*windowsDPAPICredentialStore)(nil)
)

func TestDefaultWindowsCredentialStoreUsesCurrentUserDPAPI(t *testing.T) {
	store, err := NewDefaultCredentialStore()
	if err != nil {
		t.Fatalf("new default store: %v", err)
	}
	dpapiStore, ok := store.(*windowsDPAPICredentialStore)
	if !ok {
		t.Fatalf("default Windows credential store = %T, want DPAPI store", store)
	}
	wantPath, err := DefaultCredentialPath()
	if err != nil {
		t.Fatalf("default credential path: %v", err)
	}
	if dpapiStore.path != wantPath {
		t.Fatalf("default store path = %q, want %q", dpapiStore.path, wantPath)
	}
	localAppData, err := windows.KnownFolderPath(
		windows.FOLDERID_LocalAppData,
		windows.KF_FLAG_DEFAULT,
	)
	if err != nil {
		t.Fatalf("resolve LocalAppData: %v", err)
	}
	relativePath, err := filepath.Rel(localAppData, dpapiStore.path)
	if err != nil || relativePath == "." || strings.HasPrefix(relativePath, "..") {
		t.Fatalf("default DPAPI state is outside LocalAppData: %q", dpapiStore.path)
	}
	if windowsDPAPIFlags&windows.CRYPTPROTECT_UI_FORBIDDEN == 0 {
		t.Fatal("DPAPI must forbid interactive UI in a headless connector session")
	}
	if windowsDPAPIFlags&windows.CRYPTPROTECT_LOCAL_MACHINE != 0 {
		t.Fatal("DPAPI must remain scoped to the current Windows user")
	}
}

func TestWindowsDPAPIStoreNativeRoundTripEncryptsAndPreservesIdentity(t *testing.T) {
	store := newTestWindowsDPAPIStore(t)
	if _, err := store.Load(); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("missing credential error = %v, want credential not found", err)
	}
	if _, err := store.LoadKey(); !errors.Is(err, ErrMachineKeyNotFound) {
		t.Fatalf("missing key error = %v, want machine key not found", err)
	}
	if err := store.Delete(); err != nil {
		t.Fatalf("delete missing credential: %v", err)
	}
	credential := testCredential(time.Now().UTC())
	if err := store.Save(credential); !errors.Is(err, ErrMachineKeyNotFound) {
		t.Fatalf("save without key error = %v, want machine key not found", err)
	}
	key := testMachineKey(t)
	encodedKey, err := key.encoded()
	if err != nil {
		t.Fatalf("encode test key: %v", err)
	}
	if err := store.SaveKey(key); err != nil {
		t.Fatalf("save key: %v", err)
	}
	assertProtectedWindowsState(t, store.path, credential.Token, encodedKey)
	if err := store.Save(credential); err != nil {
		t.Fatalf("save credential: %v", err)
	}
	assertProtectedWindowsState(t, store.path, credential.Token, encodedKey)

	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("load credential: %v", err)
	}
	if loaded.MachineID != credential.MachineID || loaded.Token != credential.Token ||
		loaded.BackendURL != credential.BackendURL {
		t.Fatal("DPAPI round trip changed the machine credential")
	}
	loadedKey, err := store.LoadKey()
	if err != nil {
		t.Fatalf("load key: %v", err)
	}
	wantPublicKey, _ := key.PublicKey()
	gotPublicKey, _ := loadedKey.PublicKey()
	if gotPublicKey != wantPublicKey {
		t.Fatal("DPAPI round trip changed the machine identity")
	}

	if err := store.Delete(); err != nil {
		t.Fatalf("delete credential: %v", err)
	}
	if err := store.Delete(); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("load after delete = %v, want credential not found", err)
	}
	preservedKey, err := store.LoadKey()
	if err != nil {
		t.Fatalf("load key after credential delete: %v", err)
	}
	preservedPublicKey, _ := preservedKey.PublicKey()
	if preservedPublicKey != wantPublicKey {
		t.Fatal("credential deletion changed the machine identity")
	}
	assertProtectedWindowsState(t, store.path, credential.Token, encodedKey)
	staleTemporary := filepath.Join(filepath.Dir(store.path), machineCredentialTemporaryFilePrefix+"stale")
	if err := os.WriteFile(staleTemporary, []byte("stale protected envelope"), 0o600); err != nil {
		t.Fatalf("seed stale temporary identity: %v", err)
	}
	unrelated := filepath.Join(filepath.Dir(store.path), "keep-me")
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
	if _, err := os.Stat(store.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("protected state remains after purge: %v", err)
	}
	if _, err := os.Stat(staleTemporary); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale temporary identity remains after purge: %v", err)
	}
	if body, err := os.ReadFile(unrelated); err != nil || string(body) != "unrelated" {
		t.Fatalf("purge changed unrelated file: body=%q error=%v", body, err)
	}
}

func TestWindowsDPAPIStoreRejectsTamperedAndWrongProtectedValues(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*windowsDPAPIEnvelope)
	}{
		{
			name: "tampered ciphertext",
			mutate: func(envelope *windowsDPAPIEnvelope) {
				envelope.Ciphertext[len(envelope.Ciphertext)/2] ^= 0xff
			},
		},
		{
			name: "unrelated ciphertext",
			mutate: func(envelope *windowsDPAPIEnvelope) {
				envelope.Ciphertext = bytes.Repeat([]byte{0x5a}, 256)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := newTestWindowsDPAPIStore(t)
			key := testMachineKey(t)
			credential := testCredential(time.Now().UTC())
			if err := store.SaveKey(key); err != nil {
				t.Fatalf("save key: %v", err)
			}
			if err := store.Save(credential); err != nil {
				t.Fatalf("save credential: %v", err)
			}
			envelope := readTestWindowsDPAPIEnvelope(t, store.path)
			test.mutate(&envelope)
			writeTestWindowsDPAPIEnvelope(t, store.path, envelope)
			_, err := store.Load()
			if err == nil {
				t.Fatal("invalid protected value unexpectedly loaded")
			}
			encodedKey, _ := key.encoded()
			if strings.Contains(err.Error(), credential.Token) || strings.Contains(err.Error(), encodedKey) {
				t.Fatalf("protected-state error exposed a secret: %v", err)
			}
		})
	}
}

func TestWindowsDPAPIStoreRejectsMalformedAndOversizedEnvelopes(t *testing.T) {
	store := newTestWindowsDPAPIStore(t)
	for name, body := range map[string][]byte{
		"invalid JSON":    []byte("not-json"),
		"wrong version":   []byte(`{"version":"wrong","ciphertext":"YQ=="}`),
		"unknown field":   []byte(`{"version":"project-space.machine-credential.dpapi/v1","ciphertext":"YQ==","extra":true}`),
		"multiple values": []byte(`{"version":"project-space.machine-credential.dpapi/v1","ciphertext":"YQ=="}{}`),
		"oversized":       bytes.Repeat([]byte{'x'}, maximumWindowsDPAPIEnvelopeBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(store.path, body, 0o600); err != nil {
				t.Fatalf("write invalid envelope: %v", err)
			}
			if _, err := store.Load(); err == nil {
				t.Fatal("invalid envelope unexpectedly loaded")
			}
		})
	}
}

func TestWindowsDPAPIStoreLockSerializesIndependentInstances(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machine-credential.json")
	first, err := newWindowsDPAPICredentialStore(path)
	if err != nil {
		t.Fatalf("new first store: %v", err)
	}
	second, err := newWindowsDPAPICredentialStore(path)
	if err != nil {
		t.Fatalf("new second store: %v", err)
	}
	releaseFirst, err := first.Lock(context.Background())
	if err != nil {
		t.Fatalf("lock first store: %v", err)
	}
	acquired := make(chan func() error, 1)
	failed := make(chan error, 1)
	go func() {
		release, lockErr := second.Lock(context.Background())
		if lockErr != nil {
			failed <- lockErr
			return
		}
		acquired <- release
	}()
	select {
	case release := <-acquired:
		_ = release()
		t.Fatal("second store acquired lock before the first released it")
	case err := <-failed:
		t.Fatalf("second store lock failed: %v", err)
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
	case err := <-failed:
		t.Fatalf("second store lock failed: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("second store did not acquire lock after release")
	}
}

func TestWindowsDPAPIStoreRefusesCredentialReparsePoint(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target.json")
	if err := os.WriteFile(target, []byte("do not replace"), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	path := filepath.Join(directory, "machine-credential.json")
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("Windows symlink creation unavailable: %v", err)
	}
	store, err := newWindowsDPAPICredentialStore(path)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	if err := store.SaveKey(testMachineKey(t)); err == nil {
		t.Fatal("save through a reparse point unexpectedly succeeded")
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(body) != "do not replace" {
		t.Fatal("reparse-point target was changed")
	}
}

func TestWindowsDPAPIStorePurgeRejectsReparseDirectoryAndTemporaryFile(t *testing.T) {
	root := t.TempDir()
	targetDirectory := filepath.Join(root, "target")
	if err := os.Mkdir(targetDirectory, 0o700); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	linkedDirectory := filepath.Join(root, "linked")
	if err := os.Symlink(targetDirectory, linkedDirectory); err != nil {
		t.Skipf("Windows directory symlink creation unavailable: %v", err)
	}
	sentinel := filepath.Join(targetDirectory, "machine-credential.json")
	if err := os.WriteFile(sentinel, []byte("do not remove"), 0o600); err != nil {
		t.Fatalf("write directory sentinel: %v", err)
	}
	store, err := newWindowsDPAPICredentialStore(filepath.Join(linkedDirectory, "machine-credential.json"))
	if err != nil {
		t.Fatalf("new linked DPAPI store: %v", err)
	}
	if err := store.Purge(); err == nil {
		t.Fatal("DPAPI purge through reparse directory unexpectedly succeeded")
	}
	if body, err := os.ReadFile(sentinel); err != nil || string(body) != "do not remove" {
		t.Fatalf("DPAPI purge changed directory target: body=%q error=%v", body, err)
	}

	directDirectory := filepath.Join(root, "direct")
	if err := os.Mkdir(directDirectory, 0o700); err != nil {
		t.Fatalf("create direct directory: %v", err)
	}
	directStore, err := newWindowsDPAPICredentialStore(filepath.Join(directDirectory, "machine-credential.json"))
	if err != nil {
		t.Fatalf("new direct DPAPI store: %v", err)
	}
	outside := filepath.Join(root, "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatalf("write outside sentinel: %v", err)
	}
	temporaryLink := filepath.Join(directDirectory, machineCredentialTemporaryFilePrefix+"link")
	if err := os.Symlink(outside, temporaryLink); err != nil {
		t.Skipf("Windows temporary symlink creation unavailable: %v", err)
	}
	if err := directStore.Purge(); err == nil {
		t.Fatal("DPAPI purge accepted a temporary reparse point")
	}
	if body, err := os.ReadFile(outside); err != nil || string(body) != "outside" {
		t.Fatalf("DPAPI purge changed temporary target: body=%q error=%v", body, err)
	}
}

func newTestWindowsDPAPIStore(t *testing.T) *windowsDPAPICredentialStore {
	t.Helper()
	store, err := newWindowsDPAPICredentialStore(
		filepath.Join(t.TempDir(), "machine-credential.json"),
	)
	if err != nil {
		t.Fatalf("new Windows DPAPI store: %v", err)
	}
	return store
}

func assertProtectedWindowsState(t *testing.T, path string, token string, privateKey string) {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read protected state: %v", err)
	}
	for name, secret := range map[string]string{"credential": token, "private key": privateKey} {
		if bytes.Contains(body, []byte(secret)) {
			t.Fatalf("protected state contains plaintext %s", name)
		}
	}
	envelope := readTestWindowsDPAPIEnvelope(t, path)
	if envelope.Version != windowsDPAPIStateVersion || len(envelope.Ciphertext) == 0 {
		t.Fatal("protected state envelope is incomplete")
	}
}

func readTestWindowsDPAPIEnvelope(t *testing.T, path string) windowsDPAPIEnvelope {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read protected envelope: %v", err)
	}
	var envelope windowsDPAPIEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode protected envelope: %v", err)
	}
	return envelope
}

func writeTestWindowsDPAPIEnvelope(t *testing.T, path string, envelope windowsDPAPIEnvelope) {
	t.Helper()
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("encode protected envelope: %v", err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write protected envelope: %v", err)
	}
}
