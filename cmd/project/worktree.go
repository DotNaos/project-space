package main

import (
	"fmt"
	"os"

	"github.com/DotNaos/project-space/internal/worktreeownership"
	"github.com/spf13/cobra"
)

func newWorktreeCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "worktree",
		Short: "Prepare and validate task-owned worktrees",
	}
	command.AddCommand(newWorktreePrepareCommand())
	return command
}

func newWorktreePrepareCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "prepare",
		Short: "Claim this worktree for the current persistent Codex task",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, args []string) error {
			result, err := worktreeownership.Prepare(command.Context(), worktreeownership.Options{
				ThreadID: os.Getenv("CODEX_THREAD_ID"),
			})
			if err != nil {
				return err
			}
			if result.Ownership == worktreeownership.OwnershipClaimed {
				fmt.Fprintln(command.OutOrStdout(), "Worktree claimed")
			} else {
				fmt.Fprintln(command.OutOrStdout(), "Worktree ownership confirmed")
			}
			fmt.Fprintf(command.OutOrStdout(), "Path: %s\n", result.WorktreePath)
			fmt.Fprintf(command.OutOrStdout(), "Codex thread: %s\n", result.ThreadID)
			return nil
		},
	}
}
