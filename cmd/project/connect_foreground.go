package main

import (
	"context"
	"io"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

type foregroundMachineConnector interface {
	machineconnect.Connector
	Running() bool
	Wait(context.Context) error
}

type foregroundMachineConnectorRuntime struct {
	runtime *connectorSourceRuntime
}

func newForegroundMachineConnector(
	store machineconnect.CredentialStore,
	stdout io.Writer,
	stderr io.Writer,
) (foregroundMachineConnector, error) {
	binary, err := resolveConnectorBinary()
	if err != nil {
		return nil, err
	}
	codexOperationSnapshotPath, err := machineconnect.DefaultCodexOperationSnapshotPath()
	if err != nil {
		return nil, err
	}
	supervisor, err := machineconnect.NewConnectorSupervisor(
		store,
		connectorSupervisorOptions(
			binary,
			"",
			codexOperationSnapshotPath,
			stdout,
			stderr,
		),
	)
	if err != nil {
		return nil, err
	}
	return &foregroundMachineConnectorRuntime{
		runtime: &connectorSourceRuntime{supervisor: supervisor},
	}, nil
}

func (connector *foregroundMachineConnectorRuntime) Start(ctx context.Context) error {
	return connector.runtime.Start(ctx)
}

func (connector *foregroundMachineConnectorRuntime) Stop(ctx context.Context) error {
	return connector.runtime.Stop(ctx)
}

func (connector *foregroundMachineConnectorRuntime) Running() bool {
	return connector.runtime.Running()
}

func (connector *foregroundMachineConnectorRuntime) Wait(ctx context.Context) error {
	return connector.runtime.Wait(ctx)
}
