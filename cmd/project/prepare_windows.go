//go:build windows

package main

import (
	"github.com/spf13/cobra"
)

func newPrepareCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"prepare [directory]",
		"Run trusted repository setup steps",
		cobra.MaximumNArgs(1),
		"prepare",
		"wsl.exe --distribution <distribution> -- project prepare",
	)
	addWindowsRuntimeOutputFlags(cmd)
	cmd.Flags().String("step", "", "stable setup step ID")
	status := newWindowsRuntimeCommand(
		"status [directory]",
		"Inspect trusted repository setup",
		cobra.MaximumNArgs(1),
		"prepare status",
		"wsl.exe --distribution <distribution> -- project prepare status",
	)
	addWindowsRuntimeOutputFlags(status)
	status.Flags().String("step", "", "stable setup step ID")
	cmd.AddCommand(status)
	return cmd
}
