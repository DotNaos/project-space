package main

import (
	"context"
	"io"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/spf13/cobra"
)

type connectorSupervisor interface {
	Run(context.Context) error
}

var (
	projectMachineClientReleaseID = "dev"
	projectMachineClientBuildID   = "unknown"
)

type connectorRunDependencies struct {
	NewStore                func() (machineconnect.CredentialStore, error)
	ResolveBinary           func() (string, error)
	ConsumeReadinessAttempt func() (string, bool, error)
	NewSupervisor           func(
		machineconnect.CredentialStore,
		string,
		string,
		io.Writer,
		io.Writer,
	) (connectorSupervisor, error)
}

func newConnectorRunCommand() *cobra.Command {
	return newConnectorRunCommandWithDependencies(defaultConnectorRunDependencies())
}

func newConnectorRunCommandWithDependencies(dependencies connectorRunDependencies) *cobra.Command {
	return &cobra.Command{
		Use:   "run",
		Short: "Run the authenticated Project Space connector",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			store, err := dependencies.NewStore()
			if err != nil {
				return err
			}
			binary, err := dependencies.ResolveBinary()
			if err != nil {
				return err
			}
			readinessAttemptNonce := ""
			if dependencies.ConsumeReadinessAttempt != nil {
				var found bool
				readinessAttemptNonce, found, err = dependencies.ConsumeReadinessAttempt()
				if err != nil {
					return err
				}
				if !found {
					readinessAttemptNonce = ""
				}
			}
			supervisor, err := dependencies.NewSupervisor(
				store,
				binary,
				readinessAttemptNonce,
				command.OutOrStdout(),
				command.ErrOrStderr(),
			)
			if err != nil {
				return err
			}
			return supervisor.Run(ctx)
		},
	}
}

func defaultConnectorRunDependencies() connectorRunDependencies {
	return connectorRunDependencies{
		NewStore: machineconnect.NewDefaultCredentialStore,
		ResolveBinary: func() (string, error) {
			return resolveConnectorBinary()
		},
		ConsumeReadinessAttempt: func() (string, bool, error) {
			path, err := machineconnect.DefaultConnectorRuntimeReadinessPath()
			if err != nil {
				return "", false, err
			}
			return machineconnect.ConsumeConnectorRuntimeReadinessAttempt(path)
		},
		NewSupervisor: func(
			store machineconnect.CredentialStore,
			binary string,
			readinessAttemptNonce string,
			stdout io.Writer,
			stderr io.Writer,
		) (connectorSupervisor, error) {
			return machineconnect.NewConnectorSupervisor(
				store,
				connectorSupervisorOptions(
					binary,
					readinessAttemptNonce,
					stdout,
					stderr,
				),
			)
		},
	}
}

func connectorSupervisorOptions(
	binary string,
	readinessAttemptNonce string,
	stdout io.Writer,
	stderr io.Writer,
) machineconnect.ConnectorSupervisorOptions {
	return machineconnect.ConnectorSupervisorOptions{
		BuildIdentity: machineconnect.ConnectorSupervisorBuildIdentity{
			BuildID:   projectMachineClientBuildID,
			ReleaseID: projectMachineClientReleaseID,
		},
		ReadinessAttemptNonce: readinessAttemptNonce,
		Executable:            binary,
		Stdout:                stdout,
		Stderr:                stderr,
	}
}
