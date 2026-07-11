package main

import (
	"errors"
	"fmt"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/spf13/cobra"
)

type connectorMachineServiceDependencies struct {
	NewStore              func() (machineconnect.CredentialStore, error)
	NewConnector          func() (machineconnect.Connector, error)
	LoadMachineConnection machineConnectionCommandDependencyFactory
}

func newConnectorMachineServiceCommand() *cobra.Command {
	return newConnectorMachineServiceCommandWithDependencies(
		defaultConnectorMachineServiceDependencies(),
	)
}

func newConnectorMachineServiceCommandWithDependencies(
	dependencies connectorMachineServiceDependencies,
) *cobra.Command {
	command := &cobra.Command{
		Use:    "service",
		Short:  "Manage the authenticated machine connector service",
		Hidden: true,
	}
	command.AddCommand(newConnectorMachineServiceStopCommand(dependencies))
	command.AddCommand(newConnectorMachineServiceStartCommand(dependencies))
	command.AddCommand(newConnectorMachineServiceUninstallCommand(dependencies))
	return command
}

func newConnectorMachineServiceStopCommand(
	dependencies connectorMachineServiceDependencies,
) *cobra.Command {
	return &cobra.Command{
		Use:    "stop",
		Short:  "Stop the authenticated machine connector without changing its credential",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			connector, err := dependencies.NewConnector()
			if err != nil {
				return fmt.Errorf("configure machine connector service: %w", err)
			}
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			return connector.Stop(ctx)
		},
	}
}

func newConnectorMachineServiceStartCommand(
	dependencies connectorMachineServiceDependencies,
) *cobra.Command {
	return &cobra.Command{
		Use:    "start-if-connected",
		Short:  "Start the authenticated machine connector when a credential exists",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) (returnErr error) {
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			store, err := dependencies.NewStore()
			if err != nil {
				return fmt.Errorf("configure machine credential store: %w", err)
			}
			if locker, ok := store.(machineconnect.CredentialLocker); ok {
				release, err := locker.Lock(ctx)
				if err != nil {
					return err
				}
				defer func() {
					returnErr = errors.Join(returnErr, release())
				}()
			}
			if _, err := store.Load(); errors.Is(err, machineconnect.ErrCredentialNotFound) {
				return nil
			} else if err != nil {
				return fmt.Errorf("load machine credential: %w", err)
			}
			connector, err := dependencies.NewConnector()
			if err != nil {
				return fmt.Errorf("configure machine connector service: %w", err)
			}
			return connector.Start(ctx)
		},
	}
}

func newConnectorMachineServiceUninstallCommand(
	dependencies connectorMachineServiceDependencies,
) *cobra.Command {
	return &cobra.Command{
		Use:    "uninstall",
		Short:  "Remove the local connector service and complete machine identity",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			if dependencies.LoadMachineConnection == nil {
				return errors.New("configure machine uninstall: dependency loader is missing")
			}
			machineDependencies, err := dependencies.LoadMachineConnection()
			if err != nil {
				return err
			}
			workflow, err := machineConnectionWorkflow(machineDependencies, silentApprovalPresenter{})
			if err != nil {
				return err
			}
			result, err := workflow.Uninstall(ctx)
			if err != nil {
				return err
			}
			if result.RevocationPending {
				fmt.Fprintln(command.ErrOrStderr(), "Local machine state was removed, but server access may still need removal in Project Space.")
			}
			return nil
		},
	}
}

func defaultConnectorMachineServiceDependencies() connectorMachineServiceDependencies {
	return connectorMachineServiceDependencies{
		NewStore:              machineconnect.NewDefaultCredentialStore,
		LoadMachineConnection: defaultMachineConnectionDependencies,
		NewConnector: func() (machineconnect.Connector, error) {
			return machineconnect.NewServiceConnector(machineconnect.ServiceConnectorOptions{})
		},
	}
}
