package main

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/clientaccess"
	"github.com/DotNaos/project-space/internal/computeinventory"
)

func TestSSHCommandUsesExactEnvironmentIdentityAndLocalBridge(t *testing.T) {
	var opened clientaccess.Target
	command := newSSHCommandWithDependencies(sshCommandDependencies{
		Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
			return inventoryAPI{inventory: computeinventory.Inventory{
				EnvironmentInstances: []computeinventory.EnvironmentInstance{{
					ID: "environment-1", Alias: "os-pc", Name: "OS PC", Reference: "local/host/environment-1",
					AccessRoutes: []computeinventory.AccessRoute{{
						Capabilities: []string{"interactive_shell"}, ID: "route-1", Priority: 100,
						ProviderKind: "tailscale", State: "ready", Type: "ssh_private_network",
						ClientAccess: &computeinventory.ClientAccess{
							Address: "100.64.0.10", HostKeySHA256: "SHA256:tUGJpNc2gXgnfVo/KzkCxfyqgRwITaruSw4CsbW8CXA",
							Port: 22, TargetIdentityRevision: "1:environment-identity", User: "project-user",
						},
					}},
				}},
			}}, nil
		}},
		Access: clientaccess.Dependencies{
			LookPath: func(string) (string, error) { return "/usr/bin/tool", nil },
			Run: func(_ context.Context, name string, _ []string, _ []byte) (string, string, error) {
				if name == "tailscale" {
					return `{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.2"]}}`, "", nil
				}
				return "100.64.0.10 ssh-ed25519 YWNjZXNzLWtleQ==", "", nil
			},
			Interactive: func(_ context.Context, _ io.Reader, _ io.Writer, _ io.Writer, _ string, _ []string) error {
				opened = clientaccess.Target{Address: "100.64.0.10", Port: 22, User: "project-user", TargetIdentityRevision: "1:environment-identity", HostKeySHA256: "SHA256:tUGJpNc2gXgnfVo/KzkCxfyqgRwITaruSw4CsbW8CXA"}
				return nil
			},
		},
	})
	command.SetArgs([]string{"--environment-id", "environment-1"})
	command.SetIn(strings.NewReader(""))
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if opened.Address != "100.64.0.10" || opened.TargetIdentityRevision != "1:environment-identity" {
		t.Fatalf("opened target = %#v", opened)
	}
}

func TestSSHCommandBlocksStaleAndNonTailnetRoutesBeforeLocalExecution(t *testing.T) {
	for _, route := range []computeinventory.AccessRoute{
		{ID: "stale", Priority: 100, ProviderKind: "tailscale", State: "stale", Type: "ssh_private_network"},
		{ID: "wireguard", Priority: 100, ProviderKind: "wireguard", State: "ready", Type: "ssh_private_network"},
	} {
		opened := false
		command := newSSHCommandWithDependencies(sshCommandDependencies{
			Inventory: computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
				return inventoryAPI{inventory: computeinventory.Inventory{EnvironmentInstances: []computeinventory.EnvironmentInstance{{ID: "environment-1", Alias: "os-pc", Reference: "local/host/environment-1", AccessRoutes: []computeinventory.AccessRoute{route}}}}}, nil
			}},
			Access: clientaccess.Dependencies{
				LookPath: func(string) (string, error) { return "/usr/bin/tool", nil },
				Run: func(context.Context, string, []string, []byte) (string, string, error) {
					t.Fatal("local bridge must not run")
					return "", "", nil
				},
				Interactive: func(context.Context, io.Reader, io.Writer, io.Writer, string, []string) error {
					opened = true
					return nil
				},
			},
		})
		command.SetArgs([]string{"os-pc"})
		err := command.Execute()
		var failure *clientaccess.Failure
		if !errors.As(err, &failure) || failure.Code != clientaccess.CodeTargetUnavailable || opened {
			t.Fatalf("route %#v error = %v opened = %t", route, err, opened)
		}
	}
}

type inventoryAPI struct{ inventory computeinventory.Inventory }

func (api inventoryAPI) List(context.Context) (computeinventory.Inventory, error) {
	return api.inventory, nil
}
