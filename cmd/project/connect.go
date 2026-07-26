package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/spf13/cobra"
)

type machineConnectionCommandDependencies struct {
	Backend                machineconnect.Backend
	Store                  machineconnect.CredentialStore
	Connector              machineconnect.Connector
	NewForegroundConnector func(io.Writer, io.Writer) (foregroundMachineConnector, error)
	Clock                  machineconnect.Clock
	Hostname               func() (string, error)
	Headless               func() bool
	GOOS                   string
	GOARCH                 string
	Version                string
	OpenURL                func(context.Context, string) error
	Workflow               machineconnect.WorkflowOptions
}

type machineConnectionCommandDependencyFactory func() (machineConnectionCommandDependencies, error)

type connectCommandOptions struct {
	MachineName   string
	ConnectorMode string
	NoOpen        bool
	JSON          bool
}

type browserApprovalPresenter struct {
	output  io.Writer
	noOpen  bool
	openURL func(context.Context, string) error
}

// projectSpaceMachineBackendURL may be overridden by official release builds
// with -ldflags "-X main.projectSpaceMachineBackendURL=https://...".
var projectSpaceMachineBackendURL = defaultConnectorProdHubURL
var projectMachineClientVersion = "dev"

func newConnectCommand() *cobra.Command {
	return newConnectCommandWithDependencyFactory(defaultMachineConnectionDependencies)
}

func newConnectCommandWithDependencies(dependencies machineConnectionCommandDependencies) *cobra.Command {
	return newConnectCommandWithDependencyFactory(fixedMachineConnectionDependencies(dependencies))
}

func newConnectCommandWithDependencyFactory(
	loadDependencies machineConnectionCommandDependencyFactory,
) *cobra.Command {
	options := connectCommandOptions{}
	command := &cobra.Command{
		Use:   "connect",
		Short: "Connect this machine to Project Space",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			dependencies, err := loadDependencies()
			if err != nil {
				return err
			}
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			var foreground foregroundMachineConnector
			switch options.ConnectorMode {
			case "managed":
			case "foreground":
				if dependencies.GOOS != "linux" {
					return errors.New("--connector-mode foreground is supported only on Linux")
				}
				if dependencies.NewForegroundConnector == nil {
					return errors.New("configure foreground machine connector: dependency is missing")
				}
				foreground, err = dependencies.NewForegroundConnector(
					command.OutOrStdout(),
					command.ErrOrStderr(),
				)
				if err != nil {
					return fmt.Errorf("configure foreground machine connector: %w", err)
				}
				dependencies.Connector = foreground
			default:
				return errors.New("--connector-mode must be managed or foreground")
			}
			hostname, err := dependencies.Hostname()
			if err != nil {
				return fmt.Errorf("resolve machine hostname: %w", err)
			}
			machineName := strings.TrimSpace(options.MachineName)
			if machineName == "" {
				machineName = hostname
			}
			headless := dependencies.Headless != nil && dependencies.Headless()
			presenter := browserApprovalPresenter{
				output:  command.ErrOrStderr(),
				noOpen:  options.NoOpen || headless,
				openURL: dependencies.OpenURL,
			}
			workflow, err := machineConnectionWorkflow(dependencies, presenter)
			if err != nil {
				return err
			}
			result, err := workflow.Connect(ctx, machineconnect.Machine{
				Name:          machineName,
				Hostname:      hostname,
				OS:            dependencies.GOOS,
				Architecture:  dependencies.GOARCH,
				ClientVersion: dependencies.Version,
			})
			if err != nil {
				return err
			}
			if options.JSON {
				if err := writeMachineConnectionJSON(command.OutOrStdout(), map[string]any{
					"alreadyConnected": result.AlreadyConnected,
					"machineId":        result.MachineID,
					"machineName":      result.MachineName,
					"status":           "online",
				}); err != nil {
					return err
				}
			} else if result.AlreadyConnected {
				fmt.Fprintf(command.OutOrStdout(), "Machine %s is already connected and online.\n", result.MachineName)
			} else {
				fmt.Fprintf(command.OutOrStdout(), "Machine %s is connected and online.\n", result.MachineName)
			}
			if foreground != nil && foreground.Running() {
				fmt.Fprintln(command.ErrOrStderr(), "Foreground connector is running; stop the command to take the machine offline.")
				return foreground.Wait(ctx)
			}
			return nil
		},
	}
	command.Flags().StringVar(&options.MachineName, "name", "", "machine name shown in Project Space")
	command.Flags().StringVar(
		&options.ConnectorMode,
		"connector-mode",
		"managed",
		"connector lifecycle: managed or foreground",
	)
	command.Flags().BoolVar(&options.NoOpen, "no-open", false, "print the approval URL without opening a browser")
	command.Flags().BoolVar(&options.JSON, "json", false, "print machine-readable output")
	return command
}

func (presenter browserApprovalPresenter) Present(ctx context.Context, approvalURL string) error {
	if _, err := fmt.Fprintf(presenter.output, "Approve this machine in Project Space:\n%s\n", approvalURL); err != nil {
		return err
	}
	if presenter.noOpen || presenter.openURL == nil {
		return nil
	}
	if err := presenter.openURL(ctx, approvalURL); err != nil {
		_, _ = fmt.Fprintln(presenter.output, "The browser could not be opened automatically. Open the URL above on any signed-in device.")
	}
	return nil
}

func machineConnectionWorkflow(
	dependencies machineConnectionCommandDependencies,
	presenter machineconnect.ApprovalPresenter,
) (*machineconnect.Workflow, error) {
	return machineconnect.NewWorkflow(
		dependencies.Backend,
		dependencies.Store,
		presenter,
		dependencies.Connector,
		dependencies.Clock,
		dependencies.Workflow,
	)
}

func fixedMachineConnectionDependencies(
	dependencies machineConnectionCommandDependencies,
) machineConnectionCommandDependencyFactory {
	return func() (machineConnectionCommandDependencies, error) {
		return dependencies, nil
	}
}

func defaultMachineConnectionDependencies() (machineConnectionCommandDependencies, error) {
	backend, err := machineconnect.NewHTTPBackend(projectSpaceMachineBackendURL, &http.Client{})
	if err != nil {
		return machineConnectionCommandDependencies{}, fmt.Errorf("configure Project Space backend: %w", err)
	}
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return machineConnectionCommandDependencies{}, fmt.Errorf("configure machine credential store: %w", err)
	}
	connector, err := machineconnect.NewServiceConnector(machineconnect.ServiceConnectorOptions{})
	if err != nil {
		return machineConnectionCommandDependencies{}, fmt.Errorf("configure machine connector service: %w", err)
	}
	return machineConnectionCommandDependencies{
		Backend:   backend,
		Store:     store,
		Connector: connector,
		NewForegroundConnector: func(
			stdout io.Writer,
			stderr io.Writer,
		) (foregroundMachineConnector, error) {
			return newForegroundMachineConnector(store, stdout, stderr)
		},
		Clock:    machineconnect.RealClock{},
		Hostname: os.Hostname,
		Headless: isHeadlessMachine,
		GOOS:     runtime.GOOS,
		GOARCH:   runtime.GOARCH,
		Version:  projectMachineClientVersion,
		OpenURL:  openMachineApprovalURL,
	}, nil
}

func isHeadlessMachine() bool {
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return false
	}
	if os.Getenv("SSH_TTY") != "" || os.Getenv("SSH_CONNECTION") != "" {
		return true
	}
	return runtime.GOOS == "linux" &&
		os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == ""
}

func openMachineApprovalURL(ctx context.Context, approvalURL string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.CommandContext(ctx, "open", approvalURL)
	case "windows":
		command = exec.CommandContext(ctx, "rundll32.exe", "url.dll,FileProtocolHandler", approvalURL)
	default:
		if os.Getenv("WSL_DISTRO_NAME") != "" {
			command = exec.CommandContext(ctx, "explorer.exe", approvalURL)
		} else {
			command = exec.CommandContext(ctx, "xdg-open", approvalURL)
		}
	}
	return command.Run()
}

func writeMachineConnectionJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
