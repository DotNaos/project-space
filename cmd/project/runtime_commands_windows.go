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
		"wsl.exe --distribution <distribution> -- project run",
	)
	addWindowsRuntimeOutputFlags(cmd)
	return cmd
}

func newServeCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"serve [script] [directory]",
		"Run a project script with an explicit backend binding",
		cobra.MaximumNArgs(2),
		"serve",
		"wsl.exe --distribution <distribution> -- project serve",
	)
	addWindowsRuntimeOutputFlags(cmd)
	cmd.Flags().StringArray("allowed-host", nil, "explicit Vite host allowed to reach this session (repeatable)")
	cmd.Flags().Bool("local-only", false, "start without a Tailscale route (the default; retained for compatibility)")
	cmd.Flags().Bool("tailnet", false, "publish the verified listener through Tailscale")
	cmd.Flags().String("apis", "simulated", "backend API binding: simulated or external")
	cmd.Flags().String("data", "local", "backend data binding: local or remote")
	cmd.AddCommand(newWindowsServeReconcileCommand())
	cmd.AddCommand(newWindowsServeListCommand())
	cmd.AddCommand(newWindowsServeLogsCommand())
	cmd.AddCommand(newWindowsServeAttachCommand())
	cmd.AddCommand(newWindowsServeStatusCommand())
	cmd.AddCommand(newWindowsServeStopCommand())
	return cmd
}

func newWindowsServeListCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"list [directory]",
		"List managed project server sessions",
		cobra.MaximumNArgs(1),
		"serve list",
		"wsl.exe --distribution <distribution> -- project serve list",
	)
	addWindowsRuntimeOutputFlags(cmd)
	cmd.Flags().Bool("configured", false, "list declarations from one repository instead of runtime sessions")
	return cmd
}

func newWindowsServeLogsCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"logs [directory]", "Read the bounded log for one managed project server",
		cobra.MaximumNArgs(1), "serve logs", "wsl.exe --distribution <distribution> -- project serve logs",
	)
	cmd.Flags().String("script", "dev", "configured server name")
	cmd.Flags().Bool("follow", false, "continue streaming new log output")
	return cmd
}

func newWindowsServeAttachCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"attach [directory]", "Attach to one managed project server",
		cobra.MaximumNArgs(1), "serve attach", "wsl.exe --distribution <distribution> -- project serve attach",
	)
	cmd.Flags().String("script", "dev", "configured server name")
	return cmd
}

func newWindowsServeReconcileCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"reconcile",
		"Check managed project servers and clean stale sessions",
		cobra.NoArgs,
		"serve reconcile",
		"wsl.exe --distribution <distribution> -- project serve reconcile",
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
		"wsl.exe --distribution <distribution> -- project serve status",
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
		"wsl.exe --distribution <distribution> -- project serve stop",
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
		"wsl.exe --distribution <distribution> -- project serve",
	)
	cmd.Hidden = true
	return cmd
}

func newRuntimeTmuxCommand() *cobra.Command {
	cmd := newWindowsRuntimeCommand(
		"__runtime-tmux <request-path> <log-path>", "", cobra.ExactArgs(2),
		"runtime tmux", "wsl.exe --distribution <distribution> -- project serve",
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
				"project %s is unavailable in the native Windows CLI; use the installed WSL distribution instead: %s",
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
