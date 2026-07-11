//go:build !windows

package machineconnect

import "os"

type noopConnectorSupervisorLifetime struct{}

func newConnectorSupervisorLifetime(CredentialStore) (connectorSupervisorLifetime, error) {
	return noopConnectorSupervisorLifetime{}, nil
}

func (noopConnectorSupervisorLifetime) Attach(*os.Process) error { return nil }
func (noopConnectorSupervisorLifetime) Close() error             { return nil }
