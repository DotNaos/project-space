package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func main() {
	root := newRootCommand()
	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "VIOLATION", err)
		os.Exit(1)
	}
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
	root.AddCommand(newTemplateCommand())
	root.AddCommand(newTokenCommand())
	root.AddCommand(newValidateCommand())
	return root
}
