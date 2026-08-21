package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/clientaccess"
	"github.com/DotNaos/project-space/internal/computecontrol"
	"github.com/DotNaos/project-space/internal/computeinventory"
	"github.com/spf13/cobra"
)

type bootstrapControlAPI struct {
	request              computecontrol.WorkspaceRuntimeLaunchRequest
	clientRequest        computecontrol.WorkspaceRuntimeClientLaunchRequest
	supportsPresentation bool
}

func (api *bootstrapControlAPI) Status(context.Context, computecontrol.StatusRequest) (computecontrol.ExecutionResult, error) {
	return computecontrol.ExecutionResult{}, nil
}

func (api *bootstrapControlAPI) SupportsWorkspaceRuntimePresentation(context.Context) bool {
	return api.supportsPresentation
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

func (api *bootstrapControlAPI) PrepareClientOwnedWorkspaceRuntime(
	_ context.Context,
	request computecontrol.WorkspaceRuntimeClientLaunchRequest,
) (computecontrol.WorkspaceRuntimeClientLaunchResult, error) {
	api.clientRequest = request
	return computecontrol.WorkspaceRuntimeClientLaunchResult{
		Branch: request.Branch, Commit: request.Commit, EnvironmentID: request.EnvironmentID,
		Generation: request.Generation, HostID: request.HostID, ManifestDigest: request.ManifestDigest,
		Mode: request.Mode, Operation: "workspace-runtime.start.v1", OperationID: request.OperationID,
		Profile: request.Profile, RuntimeSessionCapabilities: []string{"runtime.lifecycle", "runtime.heartbeat"},
		RuntimeSessionEndpoint:  "wss://projects.os-home.net/api/workspace-runtimes/socket",
		RuntimeSessionExpiresAt: "2099-01-01T00:00:00Z", RuntimeSessionOwnerUserID: "owner-one",
		RuntimeSessionRequestedCapabilities: []string{"runtime.codex.v1", "runtime.control.v1"},
		RuntimeSessionToken:                 strings.Repeat("A", 43), RuntimeSessionVersion: request.RuntimeVersion,
		RuntimeVersion: request.RuntimeVersion, SourceHead: request.Commit, State: "ready",
		TargetIdentityRevision: request.TargetIdentityRevision, ControlTargetIdentityRevision: "7:environment:canonical", WorkspaceID: request.WorkspaceID,
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

func TestEnvironmentBootstrapDetectsWorkspaceAndEnvironment(t *testing.T) {
	api := &bootstrapControlAPI{supportsPresentation: true}
	inventory := commandTestInventory()
	inventory.EnvironmentInstances[0].ID = "11111111-1111-4111-8111-111111111111"
	inventory.EnvironmentInstances[0].Reference = "platform-local/host-a/environment-a"
	inventory.EnvironmentInstances[0].Workspaces = []computeinventory.WorkspaceSummary{{
		ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Name: "current",
	}}
	inventory.EnvironmentInstances[1].ID = "33333333-3333-4333-8333-333333333333"
	command := newEnvironmentBootstrapCommand(environmentBootstrapDependencies{
		Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
			return &fakeComputeInventoryAPI{value: inventory}, nil
		}},
		LoadControl: func(context.Context) (computecontrol.WorkspaceRuntimeAPI, error) { return api, nil },
		NewGeneration: func() (string, error) {
			return "22222222-2222-4222-8222-222222222222", nil
		},
		NewOperationID: func(string) (string, error) { return "detected-bootstrap", nil },
		ResolvePlan: func(context.Context, string, string) (environmentLaunchPlan, error) {
			return environmentLaunchPlan{
				WorkspaceID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Branch: "issue-650",
				Commit: strings.Repeat("a", 40), ManifestDigest: strings.Repeat("b", 64),
				RuntimeVersion: "0.21.23", Mode: "process",
				WorktreeOwnerThreadID: "44444444-4444-4444-8444-444444444444",
			}, nil
		},
	})
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs(nil)
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if api.request.EnvironmentID != inventory.EnvironmentInstances[0].ID ||
		api.request.WorkspaceID != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" ||
		api.request.Generation != "22222222-2222-4222-8222-222222222222" ||
		api.request.Branch != "issue-650" || api.request.RuntimeVersion != "0.21.23" ||
		api.request.Mode != "process" ||
		api.request.WorktreeOwnerThreadID != "44444444-4444-4444-8444-444444444444" {
		t.Fatalf("detected request = %#v", api.request)
	}
}

func TestEnvironmentBootstrapClientOwnedStartsThroughExactHostSSH(t *testing.T) {
	api := &bootstrapControlAPI{}
	inventory := commandTestInventory()
	inventory.EnvironmentInstances = inventory.EnvironmentInstances[:1]
	inventory.EnvironmentInstances[0].ID = "11111111-1111-4111-8111-111111111111"
	inventory.EnvironmentInstances[0].Reference = "platform-local/host-a/11111111-1111-4111-8111-111111111111"
	inventory.EnvironmentInstances[0].Workspaces = []computeinventory.WorkspaceSummary{{
		ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Name: "current",
	}}
	inventory.EnvironmentInstances[0].AccessRoutes = []computeinventory.AccessRoute{{
		Capabilities: []string{"interactive_shell"}, ID: "route-one", Priority: 100,
		ProviderKind: "tailscale", State: "ready", Type: "ssh_private_network",
		ClientAccess: &computeinventory.ClientAccess{
			Address: "100.64.0.10", HostKeySHA256: "SHA256:tUGJpNc2gXgnfVo/KzkCxfyqgRwITaruSw4CsbW8CXA",
			Port: 22, TargetIdentityRevision: "7:environment:canonical", User: "project-user",
		},
	}}
	command := newEnvironmentBootstrapCommand(environmentBootstrapDependencies{
		Access: clientaccess.Dependencies{
			LookPath: func(string) (string, error) { return "/usr/bin/tool", nil },
			Run: func(_ context.Context, name string, _ []string, _ []byte) (string, string, error) {
				if name == "tailscale" {
					return `{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.2"]}}`, "", nil
				}
				if name == "ssh-keyscan" {
					return "100.64.0.10 ssh-ed25519 YWNjZXNzLWtleQ==\n", "", nil
				}
				return `{"environmentId":"11111111-1111-4111-8111-111111111111","generation":"22222222-2222-4222-8222-222222222222","hostId":"host-a","manifestDigest":"` + strings.Repeat("b", 64) + `","operation":"workspace-runtime.start.v1","operationId":"client-bootstrap","sourceHead":"` + strings.Repeat("a", 40) + `","state":"running","targetIdentityRevision":"7:environment:canonical","workspaceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}` + "\n", "", nil
			},
		},
		Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
			return &fakeComputeInventoryAPI{value: inventory}, nil
		}},
		LoadControl:    func(context.Context) (computecontrol.WorkspaceRuntimeAPI, error) { return api, nil },
		NewOperationID: func(string) (string, error) { return "client-bootstrap", nil },
	})
	command.SetOut(&bytes.Buffer{})
	command.SetArgs([]string{
		"11111111-1111-4111-8111-111111111111", "--client-owned", "--workspace", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"--branch", "issue-724", "--commit", strings.Repeat("a", 40), "--generation", "22222222-2222-4222-8222-222222222222",
		"--manifest-digest", strings.Repeat("b", 64), "--runtime-version", "0.5.0",
	})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if api.clientRequest.EnvironmentID != inventory.EnvironmentInstances[0].ID || api.clientRequest.HostID != "host-a" ||
		api.clientRequest.TargetIdentityRevision != "7:environment:canonical" {
		t.Fatalf("client request = %#v", api.clientRequest)
	}
}

func TestEnvironmentBootstrapOmitsPresentationForRollbackServer(t *testing.T) {
	api := &bootstrapControlAPI{}
	inventory := commandTestInventory()
	inventory.EnvironmentInstances = inventory.EnvironmentInstances[:1]
	inventory.EnvironmentInstances[0].Workspaces = []computeinventory.WorkspaceSummary{{
		ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Name: "current",
	}}
	command := newEnvironmentBootstrapCommand(environmentBootstrapDependencies{
		Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
			return &fakeComputeInventoryAPI{value: inventory}, nil
		}},
		LoadControl:    func(context.Context) (computecontrol.WorkspaceRuntimeAPI, error) { return api, nil },
		NewGeneration:  func() (string, error) { return "22222222-2222-4222-8222-222222222222", nil },
		NewOperationID: func(string) (string, error) { return "rollback-bootstrap", nil },
		ResolvePlan: func(context.Context, string, string) (environmentLaunchPlan, error) {
			return environmentLaunchPlan{
				WorkspaceID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Branch: "issue-717",
				Commit: strings.Repeat("a", 40), ManifestDigest: strings.Repeat("b", 64),
				RuntimeVersion: "0.21.23", Mode: "process",
				WorktreeOwnerThreadID: "44444444-4444-4444-8444-444444444444",
			}, nil
		},
	})
	command.SetOut(&bytes.Buffer{})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if api.request.WorktreeOwnerThreadID != "" {
		t.Fatalf("rollback request = %#v", api.request)
	}
}

func TestEnvironmentBootstrapRejectsAmbiguousEnvironmentAndDetectedMismatch(t *testing.T) {
	plan := environmentLaunchPlan{
		WorkspaceID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Branch: "issue-650",
		Commit: strings.Repeat("a", 40), ManifestDigest: strings.Repeat("b", 64),
		RuntimeVersion: "0.21.23", Mode: "process",
	}
	newCommand := func(inventory computeinventory.Inventory) *cobra.Command {
		return newEnvironmentBootstrapCommand(environmentBootstrapDependencies{
			Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
				return &fakeComputeInventoryAPI{value: inventory}, nil
			}},
			NewGeneration:  func() (string, error) { return "22222222-2222-4222-8222-222222222222", nil },
			NewOperationID: func(string) (string, error) { return "operation", nil },
			ResolvePlan: func(context.Context, string, string) (environmentLaunchPlan, error) {
				return plan, nil
			},
		})
	}

	ambiguous := commandTestInventory()
	command := newCommand(ambiguous)
	command.SetArgs(nil)
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "project environment bootstrap <environment>") {
		t.Fatalf("ambiguous environment error = %v", err)
	}

	command = newCommand(commandTestInventory())
	command.SetArgs([]string{"--branch", "different"})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "--branch does not match") {
		t.Fatalf("detected mismatch error = %v", err)
	}
}
