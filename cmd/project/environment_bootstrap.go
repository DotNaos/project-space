package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/DotNaos/project-space/internal/computecontrol"
	"github.com/DotNaos/project-space/internal/computeinventory"
	"github.com/spf13/cobra"
)

type environmentLaunchPlan struct {
	Branch                string
	Commit                string
	ManifestDigest        string
	Mode                  string
	RuntimeVersion        string
	WorkspaceID           string
	WorktreeOwnerThreadID string
}

type environmentBootstrapDependencies struct {
	Inventory      computeInventoryCommandDependencies
	LoadControl    func(context.Context) (computecontrol.WorkspaceRuntimeAPI, error)
	NewGeneration  func() (string, error)
	NewOperationID func(string) (string, error)
	ResolvePlan    func(context.Context, string, string) (environmentLaunchPlan, error)
}

type environmentBootstrapOptions struct {
	branch                string
	commit                string
	directory             string
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
	options := environmentBootstrapOptions{directory: ".", format: "text", profile: "codex"}
	command := &cobra.Command{
		Use:   "bootstrap [environment-instance]",
		Short: "Start the current Workspace Runtime in its canonical Environment",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if options.format != "text" && options.format != "json" {
				return errors.New("--format must be text or json")
			}
			if options.profile != "codex" && options.profile != "inspection" && options.profile != "mutation" {
				return errors.New("--profile must be codex, inspection, or mutation")
			}

			manual := completeManualBootstrap(options)
			var plan environmentLaunchPlan
			if !manual {
				if dependencies.ResolvePlan == nil {
					return errors.New("environment bootstrap plan resolver is missing")
				}
				resolved, err := dependencies.ResolvePlan(command.Context(), options.directory, options.mode)
				if err != nil {
					return fmt.Errorf("detect Workspace runtime plan: %w", err)
				}
				plan = resolved
				if err := applyDetectedBootstrapValues(&options, plan); err != nil {
					return err
				}
			}
			if options.mode == "" {
				options.mode = "process"
			}
			if options.profile == "mutation" {
				if options.worktreeOwnerThreadID == "" {
					options.worktreeOwnerThreadID = plan.WorktreeOwnerThreadID
				}
				if options.worktreeOwnerThreadID == "" {
					return errors.New("mutation bootstrap requires the managed Worktree owner")
				}
			} else if options.worktreeOwnerThreadID != "" {
				return errors.New("--worktree-owner-thread is only valid with --profile mutation")
			}

			if options.generation == "" {
				if dependencies.NewGeneration == nil {
					return errors.New("environment bootstrap generation dependency is missing")
				}
				generation, err := dependencies.NewGeneration()
				if err != nil {
					return fmt.Errorf("create Workspace Runtime generation: %w", err)
				}
				options.generation = generation
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies.Inventory)
			if err != nil {
				return err
			}
			selector := ""
			if len(args) == 1 {
				selector = args[0]
			}
			instance, err := selectBootstrapEnvironment(inventory.EnvironmentInstances, selector, options.workspaceID)
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
			if !manual && options.profile != "mutation" && plan.WorktreeOwnerThreadID != "" &&
				client.SupportsWorkspaceRuntimePresentation(command.Context()) {
				options.worktreeOwnerThreadID = plan.WorktreeOwnerThreadID
			}
			result, err := client.LaunchWorkspaceRuntime(command.Context(), computecontrol.WorkspaceRuntimeLaunchRequest{
				Branch: options.branch, Commit: options.commit, EnvironmentID: instance.ID,
				Generation: options.generation, ManifestDigest: options.manifestDigest,
				Mode: options.mode, OperationID: operationID, Profile: options.profile,
				RuntimeVersion: options.runtimeVersion, WorkspaceID: options.workspaceID,
				WorktreeOwnerThreadID: options.worktreeOwnerThreadID,
			})
			if err != nil {
				return fmt.Errorf("environment bootstrap %s: %w", operationID, err)
			}
			if options.format == "json" {
				return writeJSON(command.OutOrStdout(), result)
			}
			_, err = fmt.Fprintf(command.OutOrStdout(), "%s bootstrapped Workspace Runtime %s at generation %s (replayed %t)\n", instance.Reference, result.Result.WorkspaceID, result.Result.Generation, result.Replayed)
			return err
		},
	}
	flags := command.Flags()
	flags.StringVar(&options.directory, "directory", options.directory, "Project-managed Worktree to detect")
	flags.StringVar(&options.workspaceID, "workspace", "", "exact canonical Workspace ID (auto-detected)")
	flags.StringVar(&options.branch, "branch", "", "expected Workspace branch (auto-detected)")
	flags.StringVar(&options.commit, "commit", "", "expected immutable Workspace commit (auto-detected)")
	flags.StringVar(&options.generation, "generation", "", "new exact Runtime generation UUID (generated by default)")
	flags.StringVar(&options.manifestDigest, "manifest-digest", "", "pinned resolved Runtime plan SHA-256 (auto-detected)")
	flags.StringVar(&options.runtimeVersion, "runtime-version", "", "pinned Project Runtime version (auto-detected)")
	flags.StringVar(&options.mode, "mode", "", "Runtime isolation (auto-detected): process or devcontainer")
	flags.StringVar(&options.profile, "profile", options.profile, "Runtime profile: codex, inspection, or mutation")
	flags.StringVar(&options.worktreeOwnerThreadID, "worktree-owner-thread", "", "exact managed Worktree owner task UUID (auto-detected for mutation)")
	flags.StringVar(&options.operationID, "operation-id", "", "stable idempotency identity")
	flags.StringVar(&options.format, "format", options.format, "output format: text or json")
	return command
}

func completeManualBootstrap(options environmentBootstrapOptions) bool {
	return options.workspaceID != "" && options.branch != "" && options.commit != "" &&
		options.manifestDigest != "" && options.runtimeVersion != ""
}

func newEnvironmentGeneration() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate Workspace Runtime generation: %w", err)
	}
	encoded := hex.EncodeToString(value)
	return encoded[:8] + "-" + encoded[8:12] + "-4" + encoded[13:16] + "-8" + encoded[17:20] + "-" + encoded[20:], nil
}

func applyDetectedBootstrapValues(options *environmentBootstrapOptions, plan environmentLaunchPlan) error {
	for _, value := range []struct {
		name     string
		explicit *string
		detected string
	}{
		{"--workspace", &options.workspaceID, plan.WorkspaceID},
		{"--branch", &options.branch, plan.Branch},
		{"--commit", &options.commit, plan.Commit},
		{"--manifest-digest", &options.manifestDigest, plan.ManifestDigest},
		{"--runtime-version", &options.runtimeVersion, plan.RuntimeVersion},
		{"--mode", &options.mode, plan.Mode},
	} {
		if *value.explicit != "" && *value.explicit != value.detected {
			return fmt.Errorf("%s does not match the detected managed Worktree", value.name)
		}
		*value.explicit = value.detected
	}
	if options.worktreeOwnerThreadID != "" && options.worktreeOwnerThreadID != plan.WorktreeOwnerThreadID {
		return fmt.Errorf("--worktree-owner-thread does not match the detected managed Worktree")
	}
	return nil
}

func selectBootstrapEnvironment(instances []computeinventory.EnvironmentInstance, selector, workspaceID string) (computeinventory.EnvironmentInstance, error) {
	if strings.TrimSpace(selector) != "" {
		return resolveEnvironmentInstance(instances, selector)
	}
	matches := make([]computeinventory.EnvironmentInstance, 0, 1)
	for _, instance := range instances {
		for _, workspace := range instance.Workspaces {
			if workspace.ID == workspaceID {
				matches = append(matches, instance)
				break
			}
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 && len(instances) == 1 {
		return instances[0], nil
	}
	return computeinventory.EnvironmentInstance{}, fmt.Errorf("current Workspace does not resolve to one Environment Instance; run project environment instance list, then project environment bootstrap <environment>")
}
