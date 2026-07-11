package main

import (
	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

func newRuntimeLogCommand() *cobra.Command {
	return &cobra.Command{
		Use:    projectrun.RuntimeSupervisorCommandName + " <log-path>",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return projectrun.SuperviseRuntime(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout(), args[0])
		},
	}
}
