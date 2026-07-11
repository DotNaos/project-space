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

type connectorRunDependencies struct {
	NewStore      func() (machineconnect.CredentialStore, error)
	ResolveBinary func() (string, error)
	NewSupervisor func(
		machineconnect.CredentialStore,
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
			supervisor, err := dependencies.NewSupervisor(
				store,
				binary,
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
		NewSupervisor: func(
			store machineconnect.CredentialStore,
			binary string,
			stdout io.Writer,
			stderr io.Writer,
		) (connectorSupervisor, error) {
			return machineconnect.NewConnectorSupervisor(
				store,
				machineconnect.ConnectorSupervisorOptions{
					Executable: binary,
					Stdout:     stdout,
					Stderr:     stderr,
				},
			)
		},
	}
}
