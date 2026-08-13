//go:build !windows

package main

import (
	"context"

	"github.com/DotNaos/project-space/internal/workspacerun"
)

func defaultEnvironmentBootstrapDependencies(inventory computeInventoryCommandDependencies) environmentBootstrapDependencies {
	return environmentBootstrapDependencies{
		Inventory:      inventory,
		LoadControl:    loadComputeControlWorkspaceRuntimeClient,
		NewGeneration:  newEnvironmentGeneration,
		NewOperationID: newCodexOperationID,
		ResolvePlan: func(ctx context.Context, directory, mode string) (environmentLaunchPlan, error) {
			plan, err := workspacerun.ResolveLaunchPlan(ctx, directory, workspacerun.Mode(mode))
			if err != nil {
				return environmentLaunchPlan{}, err
			}
			return environmentLaunchPlan{
				Branch: plan.Branch, Commit: plan.Commit, ManifestDigest: plan.ManifestDigest,
				Mode: string(plan.Mode), RuntimeVersion: plan.RuntimeVersion, WorkspaceID: plan.WorkspaceID,
				WorktreeOwnerThreadID: plan.WorktreeOwnerThreadID,
			}, nil
		},
	}
}
