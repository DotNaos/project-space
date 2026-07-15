//go:build !windows

package main

import (
	"os"
	"syscall"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

var execConnectorSupervisor = syscall.Exec

func restartConnectorSupervisor(connectorExecutable string) error {
	projectExecutable, err := machineconnect.ResolveConnectorSupervisorRelaunchExecutable(
		connectorExecutable,
	)
	if err != nil {
		return err
	}
	return execConnectorSupervisor(
		projectExecutable,
		[]string{projectExecutable, "connector", "run"},
		os.Environ(),
	)
}
