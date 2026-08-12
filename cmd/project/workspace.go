//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/DotNaos/project-space/internal/workspacerun"
	"github.com/spf13/cobra"
)

type workspaceRuntimeManager interface {
	Start(context.Context, string, workspacerun.OperationOptions, workspacerun.Streams) (workspacerun.Result, error)
	Inspect(context.Context, string, workspacerun.OperationOptions) (workspacerun.Result, error)
	Suspend(context.Context, string, workspacerun.OperationOptions) (workspacerun.Result, error)
	Resume(context.Context, string, workspacerun.OperationOptions) (workspacerun.Result, error)
	Stop(context.Context, string, workspacerun.OperationOptions, workspacerun.Streams) (workspacerun.Result, error)
	Clean(context.Context, string, workspacerun.OperationOptions) (workspacerun.Result, error)
	Reconcile(context.Context, string, workspacerun.OperationOptions) (workspacerun.Result, error)
}

type workspaceRuntimeOptions struct {
	Format             string
	JSON               bool
	Mode               string
	ExpectedCommit     string
	ExpectedDigest     string
	ExpectedGeneration string
	ThreadID           string
}

func newWorkspaceCommand() *cobra.Command {
	return newWorkspaceCommandWithManager(newWorkspaceRuntimeManager)
}

func newWorkspaceRuntimeManager() (workspaceRuntimeManager, error) {
	return workspacerun.NewDefaultManager()
}

func newWorkspaceCommandWithManager(factory func() (workspaceRuntimeManager, error)) *cobra.Command {
	workspace := &cobra.Command{Use: "workspace", Short: "Manage one exact repository Workspace", Args: cobra.NoArgs}
	runtimeCommand := &cobra.Command{Use: "runtime", Short: "Manage the Workspace's ephemeral runtime", Args: cobra.NoArgs}
	runtimeCommand.AddCommand(newWorkspaceRuntimeOperation("start", factory))
	runtimeCommand.AddCommand(newWorkspaceRuntimeOperation("inspect", factory))
	runtimeCommand.AddCommand(newWorkspaceRuntimeOperation("suspend", factory))
	runtimeCommand.AddCommand(newWorkspaceRuntimeOperation("resume", factory))
	runtimeCommand.AddCommand(newWorkspaceRuntimeOperation("stop", factory))
	runtimeCommand.AddCommand(newWorkspaceRuntimeOperation("clean", factory))
	runtimeCommand.AddCommand(newWorkspaceRuntimeOperation("reconcile", factory))
	workspace.AddCommand(runtimeCommand)
	return workspace
}

func newWorkspaceRuntimeOperation(operation string, factory func() (workspaceRuntimeManager, error)) *cobra.Command {
	options := workspaceRuntimeOptions{Format: "pretty"}
	command := &cobra.Command{
		Use:   operation + " [directory]",
		Short: workspaceOperationDescription(operation),
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			manager, err := factory()
			if err != nil {
				return err
			}
			directory := argumentOrCurrentDirectory(args)
			threadID := options.ThreadID
			if threadID == "" {
				threadID = os.Getenv("CODEX_THREAD_ID")
			}
			request := workspacerun.OperationOptions{
				Mode: workspacerun.Mode(options.Mode), ExpectedCommit: options.ExpectedCommit,
				ExpectedDigest: options.ExpectedDigest, ExpectedGeneration: options.ExpectedGeneration,
				ThreadID: threadID,
			}
			streams := workspacerun.Streams{Out: cmd.OutOrStdout(), Err: cmd.ErrOrStderr()}
			if format == "json" {
				streams.Out = cmd.ErrOrStderr()
			}
			var result workspacerun.Result
			switch operation {
			case "start":
				result, err = manager.Start(cmd.Context(), directory, request, streams)
			case "inspect":
				result, err = manager.Inspect(cmd.Context(), directory, request)
			case "suspend":
				result, err = manager.Suspend(cmd.Context(), directory, request)
			case "resume":
				result, err = manager.Resume(cmd.Context(), directory, request)
			case "stop":
				result, err = manager.Stop(cmd.Context(), directory, request, streams)
			case "clean":
				result, err = manager.Clean(cmd.Context(), directory, request)
			case "reconcile":
				result, err = manager.Reconcile(cmd.Context(), directory, request)
			default:
				return fmt.Errorf("unknown Workspace runtime operation %q", operation)
			}
			if printErr := printWorkspaceRuntimeResult(cmd, result, format); printErr != nil {
				return printErr
			}
			return err
		},
	}
	command.Flags().StringVar(&options.Format, "format", "pretty", "output format: pretty or json")
	command.Flags().BoolVar(&options.JSON, "json", false, "print machine-readable JSON output")
	command.Flags().StringVar(&options.Mode, "mode", "", "runtime provider: process or devcontainer")
	command.Flags().StringVar(&options.ExpectedCommit, "expected-commit", "", "exact approved Workspace HEAD")
	command.Flags().StringVar(&options.ExpectedDigest, "expected-digest", "", "exact resolved runtime manifest digest")
	command.Flags().StringVar(&options.ExpectedGeneration, "expected-generation", "", "exact runtime generation for lifecycle fencing")
	command.Flags().StringVar(&options.ThreadID, "thread-id", "", "exact Project-managed Worktree owner (defaults to CODEX_THREAD_ID)")
	must(command.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
	must(command.RegisterFlagCompletionFunc("mode", fixedValuesCompletion("process", "devcontainer")))
	return command
}

func printWorkspaceRuntimeResult(command *cobra.Command, result workspacerun.Result, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(command.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}
	fmt.Fprintf(command.OutOrStdout(), "Workspace: %s\n", result.WorkspaceID)
	fmt.Fprintf(command.OutOrStdout(), "Generation: %s\n", result.Generation)
	fmt.Fprintf(command.OutOrStdout(), "State: %s\n", result.State)
	fmt.Fprintf(command.OutOrStdout(), "Mode: %s\n", result.Mode)
	fmt.Fprintf(command.OutOrStdout(), "Manifest: %s\n", result.ManifestDigest)
	return nil
}

func workspaceOperationDescription(operation string) string {
	descriptions := map[string]string{
		"start": "Start or reuse an exact Workspace runtime", "inspect": "Inspect exact runtime ownership",
		"suspend": "Suspend the exact Workspace runtime", "resume": "Resume the exact Workspace runtime",
		"stop":      "Stop the exact Workspace runtime without deleting its checkout",
		"clean":     "Remove only stopped generation-owned runtime state",
		"reconcile": "Repair an interrupted runtime only from exact ownership evidence",
	}
	return descriptions[operation]
}

func newWorkspaceRuntimeIdleCommand() *cobra.Command {
	return &cobra.Command{
		Use: "__workspace-runtime-idle", Hidden: true, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			<-cmd.Context().Done()
			return cmd.Context().Err()
		},
	}
}
