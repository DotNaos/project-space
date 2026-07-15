//go:build darwin

package machineconnect

const (
	developmentConnectorKeyringAccount = "machine-credential-v1-dev"
	developmentConnectorKeyringService = "net.os-home.project-space.machine-connector.dev"
)

func newDevelopmentConnectorCredentialStore(profile ConnectorProfile) (CredentialStore, error) {
	return newKeyringCredentialStore(
		nativeKeyringBackend{},
		developmentConnectorKeyringService,
		developmentConnectorKeyringAccount,
		profile.CredentialPath,
	)
}
