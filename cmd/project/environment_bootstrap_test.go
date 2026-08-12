package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/computecontrol"
	"github.com/DotNaos/project-space/internal/computeinventory"
)

type bootstrapControlAPI struct {
	request computecontrol.WorkspaceRuntimeLaunchRequest
}

func (api *bootstrapControlAPI) Status(context.Context, computecontrol.StatusRequest) (computecontrol.ExecutionResult, error) {
	return computecontrol.ExecutionResult{}, nil
}

func (api *bootstrapControlAPI) LaunchWorkspaceRuntime(
	_ context.Context,
	request computecontrol.WorkspaceRuntimeLaunchRequest,
) (computecontrol.WorkspaceRuntimeLaunchExecution, error) {
	api.request = request
	return computecontrol.WorkspaceRuntimeLaunchExecution{
		Result: computecontrol.WorkspaceRuntimeLaunchResult{
			CheckedAt: "2026-08-12T10:00:00Z", Generation: request.Generation,
			ManifestDigest: request.ManifestDigest, Operation: "workspace-runtime.start.v1",
			OperationID: request.OperationID, SourceHead: request.Commit,
			State: "running", WorkspaceID: request.WorkspaceID,
		},
	}, nil
}

func TestEnvironmentBootstrapUsesCanonicalTypedBoundary(t *testing.T) {
	api := &bootstrapControlAPI{}
	inventory := commandTestInventory()
	inventory.EnvironmentInstances[0].ID = "11111111-1111-4111-8111-111111111111"
	inventory.EnvironmentInstances[0].Reference =
		"platform-local/host-a/11111111-1111-4111-8111-111111111111"
	command := newEnvironmentBootstrapCommand(environmentBootstrapDependencies{
		Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
			return &fakeComputeInventoryAPI{value: inventory}, nil
		}},
		LoadControl:    func(context.Context) (computecontrol.WorkspaceRuntimeAPI, error) { return api, nil },
		NewOperationID: func(string) (string, error) { return "bootstrap-operation", nil },
	})
	output := bytes.Buffer{}
	command.SetOut(&output)
	command.SetArgs([]string{
		"11111111-1111-4111-8111-111111111111", "--workspace", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"--branch", "issue-648", "--commit", strings.Repeat("a", 40),
		"--generation", "22222222-2222-4222-8222-222222222222",
		"--manifest-digest", strings.Repeat("b", 64), "--runtime-version", "0.5.0",
	})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if api.request.EnvironmentID != "11111111-1111-4111-8111-111111111111" ||
		api.request.OperationID != "bootstrap-operation" || api.request.Profile != "codex" ||
		strings.Contains(output.String(), "Connector") {
		t.Fatalf("request = %#v, output = %q", api.request, output.String())
	}

	command = newEnvironmentBootstrapCommand(environmentBootstrapDependencies{
		Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
			return &fakeComputeInventoryAPI{value: inventory}, nil
		}},
		LoadControl:    func(context.Context) (computecontrol.WorkspaceRuntimeAPI, error) { return api, nil },
		NewOperationID: func(string) (string, error) { return "inspection-operation", nil },
	})
	command.SetOut(&bytes.Buffer{})
	command.SetArgs([]string{
		"11111111-1111-4111-8111-111111111111", "--workspace", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"--branch", "issue-648", "--commit", strings.Repeat("a", 40),
		"--generation", "22222222-2222-4222-8222-222222222222",
		"--manifest-digest", strings.Repeat("b", 64), "--runtime-version", "0.5.0",
		"--profile", "inspection",
	})
	if err := command.Execute(); err != nil || api.request.Profile != "inspection" {
		t.Fatalf("inspection request = %#v, err = %v", api.request, err)
	}

	command = newEnvironmentBootstrapCommand(environmentBootstrapDependencies{
		Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
			return &fakeComputeInventoryAPI{value: inventory}, nil
		}},
		LoadControl:    func(context.Context) (computecontrol.WorkspaceRuntimeAPI, error) { return api, nil },
		NewOperationID: func(string) (string, error) { return "mutation-operation", nil },
	})
	command.SetOut(&bytes.Buffer{})
	command.SetArgs([]string{
		"11111111-1111-4111-8111-111111111111", "--workspace", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"--branch", "issue-648", "--commit", strings.Repeat("a", 40),
		"--generation", "22222222-2222-4222-8222-222222222222",
		"--manifest-digest", strings.Repeat("b", 64), "--runtime-version", "0.5.0",
		"--profile", "mutation", "--worktree-owner-thread", "33333333-3333-4333-8333-333333333333",
	})
	if err := command.Execute(); err != nil || api.request.Profile != "mutation" ||
		api.request.WorktreeOwnerThreadID != "33333333-3333-4333-8333-333333333333" {
		t.Fatalf("mutation request = %#v, err = %v", api.request, err)
	}
}
