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
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(newAdoptCommand())
	root.AddCommand(newConnectorCommand())
	root.AddCommand(newCreateCommand())
	root.AddCommand(newDeployCommand())
	root.AddCommand(newInitCommand())
	root.AddCommand(newModuleCommand())
	root.AddCommand(newRuntimeLogCommand())
	root.AddCommand(newRunCommand())
	root.AddCommand(newServeCommand())
	root.AddCommand(newTemplateCommand())
	root.AddCommand(newTokenCommand())
	root.AddCommand(newValidateCommand())
	root.AddCommand(newWorktreeCommand())
	return root
}
