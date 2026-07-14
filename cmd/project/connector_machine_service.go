package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/spf13/cobra"
)

type connectorMachineServiceDependencies struct {
	NewStore              func() (machineconnect.CredentialStore, error)
	NewConnector          func() (machineconnect.Connector, error)
	LoadMachineConnection machineConnectionCommandDependencyFactory
	ReadinessPath         func() (string, error)
	BeginReadiness        func(string) (string, error)
	ClearReadinessAttempt func(string) error
	WaitForReadiness      func(
		context.Context,
		string,
		machineconnect.ConnectorRuntimeReadinessIdentity,
	) error
	ReadinessTimeout time.Duration
	BuildIdentity    machineconnect.ConnectorSupervisorBuildIdentity
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
			credential, err := store.Load()
			if errors.Is(err, machineconnect.ErrCredentialNotFound) {
				return nil
			} else if err != nil {
				return fmt.Errorf("load machine credential: %w", err)
			}
			if dependencies.ReadinessPath == nil || dependencies.BeginReadiness == nil ||
				dependencies.ClearReadinessAttempt == nil ||
				dependencies.WaitForReadiness == nil || dependencies.ReadinessTimeout <= 0 {
				return errors.New("configure authenticated connector readiness: dependencies are incomplete")
			}
			readinessPath, err := dependencies.ReadinessPath()
			if err != nil {
				return fmt.Errorf("resolve authenticated connector readiness: %w", err)
			}
			attemptNonce, err := dependencies.BeginReadiness(readinessPath)
			if err != nil {
				return fmt.Errorf("begin authenticated connector readiness: %w", err)
			}
			defer func() {
				returnErr = errors.Join(
					returnErr,
					dependencies.ClearReadinessAttempt(readinessPath),
				)
			}()
			connector, err := dependencies.NewConnector()
			if err != nil {
				return fmt.Errorf("configure machine connector service: %w", err)
			}
			if err := connector.Start(ctx); err != nil {
				return err
			}
			readinessContext, cancelReadiness := context.WithTimeout(
				ctx,
				dependencies.ReadinessTimeout,
			)
			defer cancelReadiness()
			expected := machineconnect.ConnectorRuntimeReadinessIdentity{
				MachineID:    credential.MachineID,
				BuildID:      dependencies.BuildIdentity.BuildID,
				ReleaseID:    dependencies.BuildIdentity.ReleaseID,
				AttemptNonce: attemptNonce,
			}
			if err := dependencies.WaitForReadiness(
				readinessContext,
				readinessPath,
				expected,
			); err != nil {
				return fmt.Errorf("verify authenticated connector reconnect: %w", err)
			}
			return nil
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
		ReadinessPath:         machineconnect.DefaultConnectorRuntimeReadinessPath,
		BeginReadiness:        machineconnect.BeginConnectorRuntimeReadinessAttempt,
		ClearReadinessAttempt: machineconnect.ClearConnectorRuntimeReadinessAttempt,
		WaitForReadiness:      machineconnect.WaitForConnectorRuntimeReadiness,
		ReadinessTimeout:      30 * time.Second,
		BuildIdentity: machineconnect.ConnectorSupervisorBuildIdentity{
			BuildID: projectMachineClientBuildID, ReleaseID: projectMachineClientReleaseID,
		},
		NewConnector: func() (machineconnect.Connector, error) {
			return machineconnect.NewServiceConnector(machineconnect.ServiceConnectorOptions{})
		},
	}
}
