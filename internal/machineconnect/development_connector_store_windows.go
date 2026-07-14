//go:build windows

package machineconnect

import "errors"

func newDevelopmentConnectorCredentialStore(ConnectorProfile) (CredentialStore, error) {
	return nil, errors.New("development connector profiles must run inside WSL on Windows")
}
