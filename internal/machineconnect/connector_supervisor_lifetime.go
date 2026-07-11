package machineconnect

import (
	"errors"
	"os"
)

var ErrConnectorRuntimeAlreadyRunning = errors.New("connector runtime is already running")

type connectorSupervisorLifetime interface {
	Attach(*os.Process) error
	Close() error
}

type connectorRuntimeLockPathProvider interface {
	connectorRuntimeLockPath() string
}
