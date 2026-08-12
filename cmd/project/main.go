package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), projectTerminationSignals()...)
	defer stop()
	root := newRootCommand()
	if err := root.ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "VIOLATION", err)
		os.Exit(1)
	}
}

func projectTerminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}
}

func newRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:           "project",
		Short:         "Template-aware Project CLI",
		Version:       projectMachineClientVersion,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(newAdoptCommand())
	root.AddCommand(newDefaultAgentCommand())
	root.AddCommand(newDefaultChatCommand())
	root.AddCommand(newCodexCommand())
	root.AddCommand(newConnectCommand())
	root.AddCommand(newControlCommand())
	root.AddCommand(newControlGatewayCommand())
	root.AddCommand(newConnectorCommand())
	root.AddCommand(newCreateCommand())
	root.AddCommand(newCLIDocsCommand())
	root.AddCommand(newDeployCommand())
	root.AddCommand(newDevBuildCommand())
	root.AddCommand(newDisconnectCommand())
	root.AddCommand(newMachineDoctorCommand())
	root.AddCommand(newMachineCommand())
	root.AddCommand(newInitCommand())
	root.AddCommand(newInventoryCommand())
	root.AddCommand(newProjectListCommand())
	root.AddCommand(newModuleCommand())
	root.AddCommand(newPlatformCommand())
	root.AddCommand(newProjectOpenCommand())
	root.AddCommand(newProjectPathCommand())
	root.AddCommand(newPrepareCommand())
	root.AddCommand(newRuntimeLogCommand())
	root.AddCommand(newRuntimeTmuxCommand())
	root.AddCommand(newRunCommand())
	root.AddCommand(newRoadmapCommand())
	root.AddCommand(newSelfUpdateCommand())
	root.AddCommand(newServeCommand())
	root.AddCommand(newMachineStatusCommand())
	root.AddCommand(newTemplateCommand())
	root.AddCommand(newHostCommand())
	root.AddCommand(newEnvironmentCommand())
	root.AddCommand(newTokenCommand())
	root.AddCommand(newValidateCommand())
	root.AddCommand(newWorktreeCommand())
	root.AddCommand(newWorkspaceCommand())
	root.AddCommand(newWorkspaceRuntimeIdleCommand())
	return root
}
