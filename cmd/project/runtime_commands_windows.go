//go:build windows

package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newRunCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"run <script> [directory]",
		"Run a configured project script in the foreground",
		cobra.RangeArgs(1, 2),
		"run",
		"wsl.exe --distribution Ubuntu -- project run",
	)
	addWindowsRuntimeOutputFlags(cmd)
	return cmd
}

func newServeCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"serve [script] [directory]",
		"Run a project script and expose it on this Tailnet",
		cobra.MaximumNArgs(2),
		"serve",
		"wsl.exe --distribution Ubuntu -- project serve",
	)
	addWindowsRuntimeOutputFlags(cmd)
	cmd.Flags().StringArray("allowed-host", nil, "explicit Vite host allowed to reach this session (repeatable)")
	cmd.AddCommand(newWindowsServeReconcileCommand())
	cmd.AddCommand(newWindowsServeStatusCommand())
	cmd.AddCommand(newWindowsServeStopCommand())
	return cmd
}

func newWindowsServeReconcileCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"reconcile",
		"Check managed project servers and clean stale sessions",
		cobra.NoArgs,
		"serve reconcile",
		"wsl.exe --distribution Ubuntu -- project serve reconcile",
	)
	addWindowsRuntimeOutputFlags(cmd)
	return cmd
}

func newWindowsServeStatusCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"status [directory]",
		"Inspect a managed project server",
		cobra.MaximumNArgs(1),
		"serve status",
		"wsl.exe --distribution Ubuntu -- project serve status",
	)
	cmd.ValidArgsFunction = directoryCompletion
	addWindowsRuntimeOutputFlags(cmd)
	cmd.Flags().String("script", "dev", "configured script name")
	return cmd
}

func newWindowsServeStopCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"stop [directory]",
		"Stop one managed project server",
		cobra.MaximumNArgs(1),
		"serve stop",
		"wsl.exe --distribution Ubuntu -- project serve stop",
	)
	cmd.ValidArgsFunction = directoryCompletion
	addWindowsRuntimeOutputFlags(cmd)
	cmd.Flags().String("script", "dev", "configured script name")
	return cmd
}

func newRuntimeLogCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"__runtime-supervisor <log-path>",
		"",
		cobra.ExactArgs(1),
		"runtime supervisor",
		"wsl.exe --distribution Ubuntu -- project serve",
	)
	cmd.Hidden = true
	return cmd
}

func newWindowsRuntimeCommand(
	use string,
	short string,
	args cobra.PositionalArgs,
	commandName string,
	wslCommand string,
) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
		Args:  args,
		RunE: func(*cobra.Command, []string) error {
			return fmt.Errorf(
				"project %s is unavailable in the native Windows CLI; use WSL (Ubuntu) instead: %s",
				commandName,
				wslCommand,
			)
		},
	}
}

func addWindowsRuntimeOutputFlags(cmd *cobra.Command) {
	cmd.Flags().String("format", "pretty", "output format: pretty or json")
	cmd.Flags().Bool("json", false, "print machine-readable JSON output")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
}
