package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/DotNaos/project-space/internal/computecontrol"
	"github.com/spf13/cobra"
)

type environmentBootstrapDependencies struct {
	Inventory      computeInventoryCommandDependencies
	LoadControl    func(context.Context) (computecontrol.WorkspaceRuntimeAPI, error)
	NewOperationID func(string) (string, error)
}

type environmentBootstrapOptions struct {
	branch                string
	commit                string
	format                string
	generation            string
	manifestDigest        string
	mode                  string
	operationID           string
	profile               string
	runtimeVersion        string
	workspaceID           string
	worktreeOwnerThreadID string
}

func newEnvironmentBootstrapCommand(dependencies environmentBootstrapDependencies) *cobra.Command {
	options := environmentBootstrapOptions{format: "text", mode: "process", profile: "codex"}
	command := &cobra.Command{
		Use:   "bootstrap <environment-instance>",
		Short: "Start a pinned Workspace Runtime without installing a permanent Connector",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if options.format != "text" && options.format != "json" {
				return errors.New("--format must be text or json")
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies.Inventory)
			if err != nil {
				return err
			}
			instance, err := resolveEnvironmentInstance(inventory.EnvironmentInstances, args[0])
			if err != nil {
				return err
			}
			operationID := options.operationID
			if operationID == "" {
				if dependencies.NewOperationID == nil {
					return errors.New("create bootstrap operation ID")
				}
				operationID, err = dependencies.NewOperationID("environment-bootstrap")
				if err != nil {
					return errors.New("create bootstrap operation ID")
				}
			}
			if dependencies.LoadControl == nil {
				return errors.New("environment bootstrap control dependency is missing")
			}
			client, err := dependencies.LoadControl(command.Context())
			if err != nil {
				return err
			}
			result, err := client.LaunchWorkspaceRuntime(command.Context(), computecontrol.WorkspaceRuntimeLaunchRequest{
				Branch: options.branch, Commit: options.commit, EnvironmentID: instance.ID,
				Generation: options.generation, ManifestDigest: options.manifestDigest,
				Mode: options.mode, OperationID: operationID,
				Profile:        options.profile,
				RuntimeVersion: options.runtimeVersion, WorkspaceID: options.workspaceID,
				WorktreeOwnerThreadID: options.worktreeOwnerThreadID,
			})
			if err != nil {
				return fmt.Errorf("environment bootstrap %s: %w", operationID, err)
			}
			if options.format == "json" {
				return writeJSON(command.OutOrStdout(), result)
			}
			_, err = fmt.Fprintf(
				command.OutOrStdout(),
				"%s bootstrapped Workspace Runtime %s at generation %s (replayed %t)\n",
				instance.Reference, result.Result.WorkspaceID, result.Result.Generation, result.Replayed,
			)
			return err
		},
	}
	flags := command.Flags()
	flags.StringVar(&options.workspaceID, "workspace", "", "exact canonical Workspace ID")
	flags.StringVar(&options.branch, "branch", "", "expected Workspace branch")
	flags.StringVar(&options.commit, "commit", "", "expected immutable Workspace commit")
	flags.StringVar(&options.generation, "generation", "", "new exact Runtime generation UUID")
	flags.StringVar(&options.manifestDigest, "manifest-digest", "", "pinned Runtime manifest SHA-256")
	flags.StringVar(&options.runtimeVersion, "runtime-version", "", "pinned Project Runtime version")
	flags.StringVar(&options.mode, "mode", options.mode, "Runtime isolation: process or devcontainer")
	flags.StringVar(&options.profile, "profile", options.profile, "Runtime profile: codex, inspection, or mutation")
	flags.StringVar(&options.worktreeOwnerThreadID, "worktree-owner-thread", "", "exact managed Worktree owner task UUID (mutation profile only)")
	flags.StringVar(&options.operationID, "operation-id", "", "stable idempotency identity")
	flags.StringVar(&options.format, "format", options.format, "output format: text or json")
	for _, name := range []string{
		"workspace", "branch", "commit", "generation", "manifest-digest", "runtime-version",
	} {
		_ = command.MarkFlagRequired(name)
	}
	return command
}
