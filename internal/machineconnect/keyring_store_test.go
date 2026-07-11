package machineconnect

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var errFakeKeyringMissing = errors.New("fake keyring item is missing")

type fakeKeyringBackend struct {
	deleteErr error
	getErr    error
	items     map[string]string
	setErr    error
}

func (backend *fakeKeyringBackend) key(service, account string) string {
	return service + "\x00" + account
}

func (backend *fakeKeyringBackend) Delete(service, account string) error {
	if backend.deleteErr != nil {
		return backend.deleteErr
	}
	key := backend.key(service, account)
	if _, exists := backend.items[key]; !exists {
		return errFakeKeyringMissing
	}
	delete(backend.items, key)
	return nil
}

func (backend *fakeKeyringBackend) Get(service, account string) (string, error) {
	if backend.getErr != nil {
		return "", backend.getErr
	}
	value, exists := backend.items[backend.key(service, account)]
	if !exists {
		return "", errFakeKeyringMissing
	}
	return value, nil
}

func (*fakeKeyringBackend) IsNotFound(err error) bool {
	return errors.Is(err, errFakeKeyringMissing)
}

func (backend *fakeKeyringBackend) Set(service, account, secret string) error {
	if backend.setErr != nil {
		return backend.setErr
	}
	backend.items[backend.key(service, account)] = secret
	return nil
}

func newFakeKeyringStore(t *testing.T, backend *fakeKeyringBackend) *keyringCredentialStore {
	t.Helper()
	store, err := newKeyringCredentialStore(
		backend,
		"test.project-space",
		"machine",
		filepath.Join(t.TempDir(), "machine-credential.json"),
	)
	if err != nil {
		t.Fatalf("new keyring store: %v", err)
	}
	return store
}

func TestKeyringCredentialStoreRoundTripAndDelete(t *testing.T) {
	backend := &fakeKeyringBackend{items: map[string]string{}}
	store := newFakeKeyringStore(t, backend)
	credential := testCredential(time.Now().UTC())
	key := testMachineKey(t)

	if err := store.SaveKey(key); err != nil {
		t.Fatalf("save key: %v", err)
	}
	if err := store.Save(credential); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.Token != credential.Token {
		t.Fatal("secure credential round trip changed the value")
	}
	if err := store.Delete(); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := store.Delete(); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("load after delete = %v, want credential not found", err)
	}
	if _, err := store.LoadKey(); err != nil {
		t.Fatalf("load key after credential delete: %v", err)
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
}

func TestKeyringCredentialStoreUsesCrossProcessLock(t *testing.T) {
	store := newFakeKeyringStore(t, &fakeKeyringBackend{items: map[string]string{}})
	release, err := store.Lock(context.Background())
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
}

func TestKeyringCredentialStoreRejectsMalformedAndOversizedValues(t *testing.T) {
	backend := &fakeKeyringBackend{items: map[string]string{}}
	store := newFakeKeyringStore(t, backend)
	key := backend.key(store.service, store.account)

	backend.items[key] = "not-json"
	if _, err := store.Load(); err == nil {
		t.Fatal("expected malformed secure value to fail")
	}
	backend.items[key] = strings.Repeat("x", maximumKeyringCredentialBytes+1)
	if _, err := store.Load(); err == nil {
		t.Fatal("expected oversized secure value to fail")
	}
}

func TestKeyringErrorsAndFormattingNeverRevealCredentialSecrets(t *testing.T) {
	credential := testCredential(time.Now().UTC())
	backend := &fakeKeyringBackend{
		items: map[string]string{},
	}
	store := newFakeKeyringStore(t, backend)
	key := testMachineKey(t)
	if err := store.SaveKey(key); err != nil {
		t.Fatalf("save key: %v", err)
	}
	backend.setErr = errors.New("backend leaked " + credential.Token)
	err := store.Save(credential)
	if err == nil || strings.Contains(err.Error(), credential.Token) {
		t.Fatalf("save error exposed credential: %v", err)
	}
	for _, formatted := range []string{
		credential.String(),
		credential.GoString(),
		fmt.Sprintf("%v", credential),
		fmt.Sprintf("%+v", credential),
		fmt.Sprintf("%#v", credential),
	} {
		if strings.Contains(formatted, credential.Token) {
			t.Fatalf("credential formatting exposed a secret: %s", formatted)
		}
	}
	encodedKey, _ := key.encoded()
	for _, formatted := range []string{fmt.Sprintf("%v", key), fmt.Sprintf("%#v", key)} {
		if strings.Contains(formatted, encodedKey) {
			t.Fatalf("machine key formatting exposed a secret: %s", formatted)
		}
	}
}
