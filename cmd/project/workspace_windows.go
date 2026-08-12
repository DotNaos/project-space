//go:build windows

package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

type workspaceRuntimeManager interface{}

func newWorkspaceRuntimeManager() (workspaceRuntimeManager, error) {
	return nil, fmt.Errorf("Workspace Runtime target operations are unavailable in the native Windows CLI")
}

func newWorkspaceCommand() *cobra.Command {
	workspace := &cobra.Command{Use: "workspace", Short: "Manage one exact repository Workspace", Args: cobra.NoArgs}
	runtimeCommand := &cobra.Command{Use: "runtime", Short: "Manage the Workspace's ephemeral runtime", Args: cobra.NoArgs}
	for _, operation := range []string{"start", "inspect", "suspend", "resume", "stop", "clean", "reconcile"} {
		command := newWindowsRuntimeCommand(
			operation+" [directory]",
			"Manage a Workspace Runtime through an installed WSL distribution",
			cobra.MaximumNArgs(1),
			"workspace runtime "+operation,
			"wsl.exe --distribution <distribution> -- project workspace runtime "+operation,
		)
		addWindowsRuntimeOutputFlags(command)
		command.Flags().String("mode", "", "runtime provider: process or devcontainer")
		command.Flags().String("expected-commit", "", "exact approved Workspace HEAD")
		command.Flags().String("expected-digest", "", "exact resolved runtime manifest digest")
		command.Flags().String("expected-generation", "", "exact runtime generation for lifecycle fencing")
		command.Flags().String("thread-id", "", "exact Project-managed Worktree owner")
		runtimeCommand.AddCommand(command)
	}
	retention := newWindowsRuntimeCommand(
		"retention", "Run the privileged Workspace Runtime archive collector through WSL",
		cobra.ArbitraryArgs, "workspace runtime retention", "wsl.exe --distribution <distribution> -- project workspace runtime retention",
	)
	runtimeCommand.AddCommand(retention)
	workspace.AddCommand(runtimeCommand)
	return workspace
}

func newWorkspaceRuntimeIdleCommand() *cobra.Command {
	command := newWindowsRuntimeCommand(
		"__workspace-runtime-idle", "", cobra.NoArgs,
		"Workspace Runtime idle process", "wsl.exe --distribution <distribution> -- project workspace runtime start",
	)
	command.Hidden = true
	return command
}

func newWorkspaceRuntimeSessionCommand() *cobra.Command {
	command := newWindowsRuntimeCommand(
		"__workspace-runtime-session", "", cobra.NoArgs,
		"Workspace Runtime session", "wsl.exe --distribution <distribution> -- project workspace runtime start",
	)
	command.Hidden = true
	command.Flags().String("bootstrap", "", "protected Runtime Session bootstrap path")
	_ = command.MarkFlagRequired("bootstrap")
	return command
}
