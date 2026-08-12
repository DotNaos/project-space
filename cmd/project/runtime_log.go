//go:build !windows

package main

import (
	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

func newRuntimeLogCommand() *cobra.Command {
	command := &cobra.Command{
		Use:    projectrun.RuntimeSupervisorCommandName + " <log-path>",
		Hidden: true,
		Args:   cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			inherited, err := cmd.Flags().GetBool("inherited-log")
			if err != nil {
				return err
			}
			if inherited {
				if len(args) != 0 {
					return cobra.NoArgs(cmd, args)
				}
				return projectrun.SuperviseRuntimeWithInheritedLog(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout())
			}
			if len(args) != 1 {
				return cobra.ExactArgs(1)(cmd, args)
			}
			return projectrun.SuperviseRuntime(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout(), args[0])
		},
	}
	command.Flags().Bool("inherited-log", false, "use inherited private log descriptor")
	return command
}
