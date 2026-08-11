//go:build !windows

package main

import (
	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

func newRuntimeTmuxCommand() *cobra.Command {
	return &cobra.Command{
		Use:    projectrun.TmuxRuntimeCommandName + " <request-path> <log-path>",
		Hidden: true,
		Args:   cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return projectrun.SuperviseTmuxRuntime(cmd.Context(), args[0], args[1])
		},
	}
}
