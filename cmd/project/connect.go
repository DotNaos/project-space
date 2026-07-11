package main

import (
	"context"
	"encoding/json"
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
	Backend   machineconnect.Backend
	Store     machineconnect.CredentialStore
	Connector machineconnect.Connector
	Clock     machineconnect.Clock
	Hostname  func() (string, error)
	Headless  func() bool
	GOOS      string
	GOARCH    string
	Version   string
	OpenURL   func(context.Context, string) error
	Workflow  machineconnect.WorkflowOptions
}

type connectCommandOptions struct {
	MachineName string
	NoOpen      bool
	JSON        bool
}

type browserApprovalPresenter struct {
	output  io.Writer
	noOpen  bool
	openURL func(context.Context, string) error
}

type passiveMachineConnector struct{}

func (passiveMachineConnector) Start(context.Context) error { return nil }
func (passiveMachineConnector) Stop(context.Context) error  { return nil }

func newConnectCommand() *cobra.Command {
	return newConnectCommandWithDependencies(defaultMachineConnectionDependencies())
}

func newConnectCommandWithDependencies(dependencies machineConnectionCommandDependencies) *cobra.Command {
	options := connectCommandOptions{}
	command := &cobra.Command{
		Use:   "connect",
		Short: "Connect this machine to Project Space",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
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
			result, err := workflow.Connect(command.Context(), machineconnect.Machine{
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
				return writeMachineConnectionJSON(command.OutOrStdout(), map[string]any{
					"alreadyConnected": result.AlreadyConnected,
					"machineId":        result.MachineID,
					"machineName":      result.MachineName,
					"status":           "online",
				})
			}
			if result.AlreadyConnected {
				fmt.Fprintf(command.OutOrStdout(), "Machine %s is already connected and online.\n", result.MachineName)
			} else {
				fmt.Fprintf(command.OutOrStdout(), "Machine %s is connected and online.\n", result.MachineName)
			}
			return nil
		},
	}
	command.Flags().StringVar(&options.MachineName, "name", "", "machine name shown in Project Space")
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

func defaultMachineConnectionDependencies() machineConnectionCommandDependencies {
	backend, err := machineconnect.NewHTTPBackend(defaultConnectorProdHubURL, &http.Client{})
	if err != nil {
		panic(err)
	}
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		panic(err)
	}
	return machineConnectionCommandDependencies{
		Backend:   backend,
		Store:     store,
		Connector: passiveMachineConnector{},
		Clock:     machineconnect.RealClock{},
		Hostname:  os.Hostname,
		Headless:  isHeadlessMachine,
		GOOS:      runtime.GOOS,
		GOARCH:    runtime.GOARCH,
		Version:   "dev",
		OpenURL:   openMachineApprovalURL,
	}
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
