//go:build darwin || windows

package machineconnect

import (
	"errors"

	keyring "github.com/zalando/go-keyring"
)

const (
	machineCredentialKeyringAccount = "machine-credential-v1"
	machineCredentialKeyringService = "net.os-home.project-space.machine-connector"
)

type nativeKeyringBackend struct{}

func (nativeKeyringBackend) Delete(service, account string) error {
	return keyring.Delete(service, account)
}

func (nativeKeyringBackend) Get(service, account string) (string, error) {
	return keyring.Get(service, account)
}

func (nativeKeyringBackend) IsNotFound(err error) bool {
	return errors.Is(err, keyring.ErrNotFound)
}

func (nativeKeyringBackend) Set(service, account, secret string) error {
	return keyring.Set(service, account, secret)
}

func NewDefaultCredentialStore() (CredentialStore, error) {
	lockPath, err := DefaultCredentialPath()
	if err != nil {
		return nil, err
	}
	return newKeyringCredentialStore(
		nativeKeyringBackend{},
		machineCredentialKeyringService,
		machineCredentialKeyringAccount,
		lockPath,
	)
}
