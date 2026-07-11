//go:build darwin || windows

package machineconnect

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNativeKeyringCredentialStoreIntegration(t *testing.T) {
	if os.Getenv("PROJECT_SPACE_TEST_NATIVE_KEYRING") != "1" {
		t.Skip("set PROJECT_SPACE_TEST_NATIVE_KEYRING=1 to test the native secure store")
	}
	backend := nativeKeyringBackend{}
	service := fmt.Sprintf("net.os-home.project-space.test.%d", os.Getpid())
	account := fmt.Sprintf("machine-%d", time.Now().UnixNano())
	store, err := newKeyringCredentialStore(
		backend,
		service,
		account,
		filepath.Join(t.TempDir(), "machine-credential.json"),
	)
	if err != nil {
		t.Fatalf("new native keyring store: %v", err)
	}
	t.Cleanup(func() {
		if err := backend.Delete(service, account); err != nil && !backend.IsNotFound(err) {
			t.Errorf("clean native keyring test item: %v", err)
		}
	})

	key := testMachineKey(t)
	credential := testCredential(time.Now().UTC())
	if err := store.SaveKey(key); err != nil {
		t.Fatalf("save native machine key: %v", err)
	}
	if err := store.Save(credential); err != nil {
		t.Fatalf("save native machine credential: %v", err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("load native machine credential: %v", err)
	}
	if loaded.MachineID != credential.MachineID || loaded.Token != credential.Token {
		t.Fatal("native keyring round trip changed the machine credential")
	}
	if err := store.Delete(); err != nil {
		t.Fatalf("delete native machine credential: %v", err)
	}
	if _, err := store.LoadKey(); err != nil {
		t.Fatalf("native credential deletion removed the identity key: %v", err)
	}
}
