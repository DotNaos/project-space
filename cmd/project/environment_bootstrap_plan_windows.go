//go:build windows

package main

import (
	"context"
	"errors"

	"github.com/DotNaos/project-space/internal/clientaccess"
)

func defaultEnvironmentBootstrapDependencies(inventory computeInventoryCommandDependencies) environmentBootstrapDependencies {
	return environmentBootstrapDependencies{
		Access:         clientaccess.DefaultDependencies(),
		Inventory:      inventory,
		LoadControl:    loadComputeControlWorkspaceRuntimeClient,
		NewGeneration:  newEnvironmentGeneration,
		NewOperationID: newCodexOperationID,
		ResolvePlan: func(context.Context, string, string) (environmentLaunchPlan, error) {
			return environmentLaunchPlan{}, errors.New("automatic managed Worktree detection is unavailable on Windows; provide the explicit bootstrap flags")
		},
	}
}
