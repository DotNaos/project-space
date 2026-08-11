package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/computeinventory"
)

type fakeComputeInventoryAPI struct {
	calls int
	value computeinventory.Inventory
}

func (api *fakeComputeInventoryAPI) List(context.Context) (computeinventory.Inventory, error) {
	api.calls++
	return api.value, nil
}

func inventoryDependencies(api *fakeComputeInventoryAPI) computeInventoryCommandDependencies {
	return computeInventoryCommandDependencies{Load: func(context.Context) (computeinventory.API, error) {
		return api, nil
	}}
}

func TestInventoryJSONIsThePrimaryVersionedDiscoveryPath(t *testing.T) {
	api := &fakeComputeInventoryAPI{value: commandTestInventory()}
	command := newInventoryCommandWithDependencies(inventoryDependencies(api))
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--json"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var output computeinventory.Inventory
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("decode: %v\n%s", err, stdout)
	}
	if output.SchemaVersion != 1 || len(output.EnvironmentInstances) != 3 || api.calls != 1 {
		t.Fatalf("output = %#v, calls = %d", output, api.calls)
	}
}

func TestEnvironmentInstanceAliasAmbiguityFailsClosedWithSortedExactCandidates(t *testing.T) {
	api := &fakeComputeInventoryAPI{value: commandTestInventory()}
	command := newEnvironmentInstanceShowCommand(inventoryDependencies(api))
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"same-name"})
	err := command.Execute()
	if err == nil {
		t.Fatal("expected ambiguous selector failure")
	}
	want := "platform-local/host-a/environment-a [environment-a], platform-local/host-b/environment-b [environment-b]"
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error = %q, want candidates %q", err, want)
	}
	if api.calls != 1 {
		t.Fatalf("inventory calls = %d", api.calls)
	}
}

func TestEnvironmentInstancePrefersExactIDAndCanonicalReference(t *testing.T) {
	for _, selector := range []string{
		"environment-a",
		"platform-local/host-a/environment-a",
	} {
		api := &fakeComputeInventoryAPI{value: commandTestInventory()}
		command := newEnvironmentInstanceShowCommand(inventoryDependencies(api))
		stdout := &bytes.Buffer{}
		command.SetOut(stdout)
		command.SetErr(&bytes.Buffer{})
		command.SetArgs([]string{selector, "--format", "json"})
		if err := command.Execute(); err != nil {
			t.Fatalf("selector %q: %v", selector, err)
		}
		if !strings.Contains(stdout.String(), `"id": "environment-a"`) {
			t.Fatalf("selector %q output = %s", selector, stdout)
		}
	}
}

func TestMachineInventoryCompatibilityWarnsOnStderrAndPreservesJSON(t *testing.T) {
	api := &fakeComputeInventoryAPI{value: commandTestInventory()}
	command := newHostListCommand(inventoryDependencies(api), true)
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)
	command.SetArgs([]string{"--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var output hostListEnvelope
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("JSON stdout: %v\n%s", err, stdout)
	}
	if len(output.Hosts) != 2 {
		t.Fatalf("hosts = %#v", output.Hosts)
	}
	if !strings.Contains(stderr.String(), "DEPRECATED") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestEnvironmentInstanceFiltersResolveExactParents(t *testing.T) {
	api := &fakeComputeInventoryAPI{value: commandTestInventory()}
	command := newEnvironmentInstanceListCommand(inventoryDependencies(api))
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--host", "host-a", "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var output instanceListEnvelope
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(output.EnvironmentInstances) != 1 || output.EnvironmentInstances[0].ID != "environment-a" {
		t.Fatalf("instances = %#v", output.EnvironmentInstances)
	}
}

func commandTestInventory() computeinventory.Inventory {
	definition := computeinventory.EnvironmentDefinition{
		BootstrapStrategy: "ssh", ID: "definition-linux", Kind: "native_linux", Name: "Linux",
		OperatingSystemFamily: "linux", Ownership: "built_in", Slug: "linux", SupportedArchitectures: []string{},
	}
	platform := computeinventory.Platform{Alias: "local", ID: "platform-local", Kind: "local", Name: "Local"}
	hosts := []computeinventory.Host{
		{Alias: "same-host", Capabilities: computeinventory.HostCapabilities{Console: []string{}, Power: []string{}, State: "unknown"}, ID: "host-a", Name: "Same Host", PlatformID: platform.ID},
		{Alias: "same-host", Capabilities: computeinventory.HostCapabilities{Console: []string{}, Power: []string{}, State: "unknown"}, ID: "host-b", Name: "Same Host", PlatformID: platform.ID},
	}
	instance := func(id, host, alias string) computeinventory.EnvironmentInstance {
		return computeinventory.EnvironmentInstance{
			AccessRoutes: []computeinventory.AccessRoute{}, Alias: alias, EnvironmentDefinitionID: definition.ID,
			HostID: host, HostResolution: "verified", Hostd: computeinventory.HostdAvailability{State: "unknown"},
			ID: id, Kind: "native_linux", Name: alias, PlatformID: platform.ID, ProviderLifecycleState: "unknown",
			Reference: platform.ID + "/" + host + "/" + id, ResourceMode: "exclusive",
			WorkspaceInventory: computeinventory.InventoryAvailability{State: "unavailable"}, Workspaces: []computeinventory.WorkspaceSummary{},
		}
	}
	return computeinventory.Inventory{
		CheckedAt: "2026-08-11T10:00:00Z", EnvironmentCatalog: []computeinventory.EnvironmentDefinition{definition},
		EnvironmentInstances: []computeinventory.EnvironmentInstance{
			instance("environment-a", "host-a", "same-name"),
			instance("environment-b", "host-b", "same-name"),
			{AccessRoutes: []computeinventory.AccessRoute{}, Alias: "codespace", EnvironmentDefinitionID: definition.ID,
				HostResolution: "not_applicable", Hostd: computeinventory.HostdAvailability{State: "unknown"}, ID: "environment-c",
				Kind: "native_linux", Name: "Codespace", PlatformID: platform.ID, ProviderLifecycleState: "unknown",
				Reference: platform.ID + "/provider/environment-c", ResourceMode: "dedicated",
				WorkspaceInventory: computeinventory.InventoryAvailability{State: "unavailable"}, Workspaces: []computeinventory.WorkspaceSummary{}},
		},
		Hosts: hosts, InventoryState: "ready", Platforms: []computeinventory.Platform{platform}, SchemaVersion: 1,
		Violations: []computeinventory.Violation{},
	}
}
