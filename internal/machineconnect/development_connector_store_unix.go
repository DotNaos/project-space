//go:build !darwin && !windows

package machineconnect

func newDevelopmentConnectorCredentialStore(profile ConnectorProfile) (CredentialStore, error) {
	return NewFileStore(profile.CredentialPath)
}
