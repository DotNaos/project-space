package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/spf13/cobra"
)

type connectorSourceDependencies struct {
	NewProfile    func() (machineconnect.ConnectorProfile, error)
	NewStore      func(machineconnect.ConnectorProfile) (machineconnect.CredentialStore, error)
	NewBackend    func() (machineconnect.Backend, error)
	NewSupervisor func(
		context.Context,
		machineconnect.ConnectorProfile,
		string,
		machineconnect.CredentialStore,
		io.Writer,
		io.Writer,
	) (connectorSupervisor, error)
	Hostname func() (string, error)
	Headless func() bool
	OpenURL  func(context.Context, string) error
	GOOS     string
	GOARCH   string
	Version  string
}

func newConnectorSourceCommand() *cobra.Command {
	return newConnectorSourceCommandWithDependencies(defaultConnectorSourceDependencies())
}

func newConnectorSourceCommandWithDependencies(dependencies connectorSourceDependencies) *cobra.Command {
	command := &cobra.Command{
		Use:   "source",
		Short: "Run an isolated development connector from source",
	}
	command.AddCommand(newConnectorSourceConnectCommand(dependencies))
	command.AddCommand(newConnectorSourceRunCommand(dependencies))
	command.AddCommand(newConnectorSourceStatusCommand(dependencies))
	return command
}

func newConnectorSourceConnectCommand(dependencies connectorSourceDependencies) *cobra.Command {
	root := ""
	machineName := ""
	noOpen := false
	jsonOutput := false
	command := &cobra.Command{
		Use:   "connect",
		Short: "Pair the isolated source development connector",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) (returnErr error) {
			profile, store, backend, supervisor, err := loadConnectorSourceRuntime(
				command.Context(), dependencies, root, command.OutOrStdout(), command.ErrOrStderr(),
			)
			if err != nil {
				return err
			}
			runtimeConnector := &connectorSourceRuntime{supervisor: supervisor}
			defer func() {
				cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(command.Context()), 5*time.Second)
				defer cancel()
				returnErr = errors.Join(returnErr, runtimeConnector.Stop(cleanupContext))
			}()
			hostname, err := dependencies.Hostname()
			if err != nil {
				return fmt.Errorf("resolve machine hostname: %w", err)
			}
			name := strings.TrimSpace(machineName)
			if name == "" {
				name = hostname
			}
			presenter := browserApprovalPresenter{
				output:  command.ErrOrStderr(),
				noOpen:  noOpen || dependencies.Headless != nil && dependencies.Headless(),
				openURL: dependencies.OpenURL,
			}
			workflow, err := machineconnect.NewWorkflow(
				backend, store, presenter, runtimeConnector, machineconnect.RealClock{}, machineconnect.WorkflowOptions{},
			)
			if err != nil {
				return err
			}
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			result, err := workflow.Connect(ctx, machineconnect.Machine{
				Name:          name,
				Hostname:      hostname,
				OS:            dependencies.GOOS,
				Architecture:  dependencies.GOARCH,
				ClientVersion: dependencies.Version,
				Channel:       string(profile.Channel),
				Source:        profile.Source,
			})
			if err != nil {
				return err
			}
			payload := map[string]any{
				"alreadyConnected": result.AlreadyConnected,
				"channel":          profile.Channel,
				"machineId":        result.MachineID,
				"machineName":      result.MachineName,
				"profile":          profile.Name,
				"source":           profile.Source,
				"status":           "paired",
			}
			if jsonOutput {
				return writeMachineConnectionJSON(command.OutOrStdout(), payload)
			}
			_, err = fmt.Fprintf(
				command.OutOrStdout(),
				"Development connector %s is paired. Run `project connector source run --root %s` to keep it online.\n",
				result.MachineName,
				root,
			)
			return err
		},
	}
	command.Flags().StringVar(&root, "root", "", "trusted Project Space source checkout")
	command.Flags().StringVar(&machineName, "name", "", "display name shown in Project Space")
	command.Flags().BoolVar(&noOpen, "no-open", false, "print the approval URL without opening a browser")
	command.Flags().BoolVar(&jsonOutput, "json", false, "print machine-readable output")
	_ = command.MarkFlagRequired("root")
	return command
}

func newConnectorSourceRunCommand(dependencies connectorSourceDependencies) *cobra.Command {
	root := ""
	command := &cobra.Command{
		Use:   "run",
		Short: "Run the paired development connector from source",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			_, _, _, supervisor, err := loadConnectorSourceRuntime(
				command.Context(), dependencies, root, command.OutOrStdout(), command.ErrOrStderr(),
			)
			if err != nil {
				return err
			}
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			return supervisor.Run(ctx)
		},
	}
	command.Flags().StringVar(&root, "root", "", "trusted Project Space source checkout")
	_ = command.MarkFlagRequired("root")
	return command
}

func newConnectorSourceStatusCommand(dependencies connectorSourceDependencies) *cobra.Command {
	jsonOutput := false
	command := &cobra.Command{
		Use:   "status",
		Short: "Show the isolated development connector status",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			profile, err := dependencies.NewProfile()
			if err != nil {
				return err
			}
			store, err := dependencies.NewStore(profile)
			if err != nil {
				return err
			}
			payload := map[string]any{
				"channel":    profile.Channel,
				"configured": false,
				"profile":    profile.Name,
				"source":     profile.Source,
				"status":     "not-configured",
			}
			credential, err := store.Load()
			if errors.Is(err, machineconnect.ErrCredentialNotFound) {
				return printConnectorSourceStatus(command, payload, jsonOutput)
			}
			if err != nil {
				return err
			}
			backend, err := dependencies.NewBackend()
			if err != nil {
				return err
			}
			state, err := backend.Connection(command.Context(), credential)
			if err != nil {
				return err
			}
			payload["configured"] = true
			payload["machineId"] = credential.MachineID
			payload["machineName"] = credential.MachineName
			payload["status"] = state
			return printConnectorSourceStatus(command, payload, jsonOutput)
		},
	}
	command.Flags().BoolVar(&jsonOutput, "json", false, "print machine-readable output")
	return command
}

func printConnectorSourceStatus(command *cobra.Command, payload map[string]any, jsonOutput bool) error {
	if jsonOutput {
		return writeMachineConnectionJSON(command.OutOrStdout(), payload)
	}
	_, err := fmt.Fprintf(
		command.OutOrStdout(),
		"Development connector: %v (%v, channel %v)\n",
		payload["status"], payload["source"], payload["channel"],
	)
	return err
}

func loadConnectorSourceRuntime(
	ctx context.Context,
	dependencies connectorSourceDependencies,
	root string,
	stdout io.Writer,
	stderr io.Writer,
) (
	machineconnect.ConnectorProfile,
	machineconnect.CredentialStore,
	machineconnect.Backend,
	connectorSupervisor,
	error,
) {
	if dependencies.NewProfile == nil || dependencies.NewStore == nil || dependencies.NewBackend == nil ||
		dependencies.NewSupervisor == nil || dependencies.Hostname == nil {
		return machineconnect.ConnectorProfile{}, nil, nil, nil,
			errors.New("source connector dependencies are incomplete")
	}
	profile, err := dependencies.NewProfile()
	if err != nil {
		return machineconnect.ConnectorProfile{}, nil, nil, nil, err
	}
	store, err := dependencies.NewStore(profile)
	if err != nil {
		return machineconnect.ConnectorProfile{}, nil, nil, nil, err
	}
	backend, err := dependencies.NewBackend()
	if err != nil {
		return machineconnect.ConnectorProfile{}, nil, nil, nil, err
	}
	supervisor, err := dependencies.NewSupervisor(ctx, profile, root, store, stdout, stderr)
	if err != nil {
		return machineconnect.ConnectorProfile{}, nil, nil, nil, err
	}
	return profile, store, backend, supervisor, nil
}

func defaultConnectorSourceDependencies() connectorSourceDependencies {
	companionDependencies := defaultConnectorSourceCompanionDependencies()
	return connectorSourceDependencies{
		NewProfile: func() (machineconnect.ConnectorProfile, error) {
			return machineconnect.NewDevelopmentConnectorProfile("")
		},
		NewStore: func(profile machineconnect.ConnectorProfile) (machineconnect.CredentialStore, error) {
			return profile.NewCredentialStore()
		},
		NewBackend: func() (machineconnect.Backend, error) {
			return machineconnect.NewHTTPBackend(projectSpaceMachineBackendURL, &http.Client{})
		},
		NewSupervisor: func(
			_ context.Context,
			profile machineconnect.ConnectorProfile,
			root string,
			store machineconnect.CredentialStore,
			stdout io.Writer,
			stderr io.Writer,
		) (connectorSupervisor, error) {
			canonicalRoot, err := canonicalConnectorSourceRoot(root)
			if err != nil {
				return nil, err
			}
			return newConnectorSourceLockedSupervisor(profile, &connectorSourceResolvingSupervisor{
				dependencies: companionDependencies,
				profile:      profile,
				root:         canonicalRoot,
				stderr:       stderr,
				stdout:       stdout,
				store:        store,
			}), nil
		},
		Hostname: os.Hostname,
		Headless: isHeadlessMachine,
		OpenURL:  openMachineApprovalURL,
		GOOS:     runtime.GOOS,
		GOARCH:   runtime.GOARCH,
		Version:  projectMachineClientVersion,
	}
}

type connectorSourceResolvingSupervisor struct {
	dependencies connectorSourceCompanionDependencies
	profile      machineconnect.ConnectorProfile
	root         string
	stderr       io.Writer
	stdout       io.Writer
	store        machineconnect.CredentialStore
}

func (supervisor *connectorSourceResolvingSupervisor) Run(ctx context.Context) error {
	companion, err := prepareConnectorSourceSupervisorCommand(
		ctx, supervisor.profile, supervisor.root, supervisor.dependencies,
	)
	if err != nil {
		return err
	}
	command, err := machineconnect.NewConnectorSupervisorCommand(
		supervisor.store,
		machineconnect.ConnectorSupervisorOptions{
			CodexOperationSnapshotPath: supervisor.profile.CodexOperationSnapshotPath,
			Executable:                 companion.Executable,
			Stdout:                     supervisor.stdout,
			Stderr:                     supervisor.stderr,
		},
		companion.Arguments,
	)
	if err != nil {
		return err
	}
	return command.Run(ctx)
}
