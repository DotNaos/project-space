//go:build darwin

package machineconnect

import "testing"

func TestDevelopmentConnectorStoreNamespacesExplicitConfigRoots(t *testing.T) {
	firstProfile, err := NewDevelopmentConnectorProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	secondProfile, err := NewDevelopmentConnectorProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	firstStore, err := newDevelopmentConnectorCredentialStore(firstProfile)
	if err != nil {
		t.Fatal(err)
	}
	secondStore, err := newDevelopmentConnectorCredentialStore(secondProfile)
	if err != nil {
		t.Fatal(err)
	}
	firstKeyring := firstStore.(*keyringCredentialStore)
	secondKeyring := secondStore.(*keyringCredentialStore)
	if firstKeyring.account == secondKeyring.account {
		t.Fatalf("isolated profiles share keyring account %q", firstKeyring.account)
	}
}
