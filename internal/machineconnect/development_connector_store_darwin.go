//go:build darwin

package machineconnect

import (
	"crypto/sha256"
	"fmt"
)

const (
	developmentConnectorKeyringAccount = "machine-credential-v1-dev"
	developmentConnectorKeyringService = "net.os-home.project-space.machine-connector.dev"
)

func newDevelopmentConnectorCredentialStore(profile ConnectorProfile) (CredentialStore, error) {
	service := developmentConnectorKeyringService
	account := developmentConnectorKeyringAccount
	defaultProfile, err := NewDevelopmentConnectorProfile("")
	if err != nil {
		return nil, err
	}
	if profile.StateRoot != defaultProfile.StateRoot {
		namespace := sha256.Sum256([]byte(profile.StateRoot))
		account = fmt.Sprintf("%s-%x", account, namespace[:8])
	}
	return newKeyringCredentialStore(
		nativeKeyringBackend{},
		service,
		account,
		profile.CredentialPath,
	)
}
