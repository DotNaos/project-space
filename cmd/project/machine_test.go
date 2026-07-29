package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/machinedirectory"
	"github.com/spf13/cobra"
)

const testPhysicalMachineID = "11111111-1111-4111-8111-111111111111"

func TestMachineListKeepsIndependentEvidenceInHumanAndJSONOutput(t *testing.T) {
	dependencies := testMachineDirectoryDependencies()
	jsonOutput := executeDirectoryCommand(
		t, newMachineListCommand(dependencies), "--format", "json",
	)
	var result machinedirectory.MachinesResult
	if err := json.Unmarshal([]byte(jsonOutput), &result); err != nil {
		t.Fatal(err)
	}
	machine := result.Machines[0]
	if machine.Tailscale.State != "reachable" ||
		machine.SSH.State != "available" ||
		machine.Connector.State != "unavailable" ||
		machine.CodexAppServer.State != "stale" {
		t.Fatalf("machine evidence was collapsed: %#v", machine)
	}
	if strings.Contains(strings.ToLower(jsonOutput), "powered") {
		t.Fatalf("output inferred a power state:\n%s", jsonOutput)
	}

	human := executeDirectoryCommand(t, newMachineListCommand(dependencies))
	for _, value := range []string{
		"TAILSCALE", "SSH", "CONNECTOR", "APP SERVER",
		"reachable", "available", "unavailable", "stale",
		"Partial evidence",
	} {
		if !strings.Contains(human, value) {
			t.Fatalf("human output missing %q:\n%s", value, human)
		}
	}
}

func TestMachineStatusSelectsStableIDAndSSHDoesNotRequireConnector(t *testing.T) {
	dependencies := testMachineDirectoryDependencies()
	target := ""
	dependencies.RunSSH = func(value string) error {
		target = value
		return nil
	}
	output := executeDirectoryCommand(
		t, newMachineStatusDirectoryCommand(dependencies),
		"--machine-id", testPhysicalMachineID,
	)
	if !strings.Contains(output, "Machine: os-pc") ||
		!strings.Contains(output, "Connector: unavailable") {
		t.Fatalf("status output:\n%s", output)
	}
	executeDirectoryCommand(
		t, newMachineSSHCommand(dependencies),
		"--machine", "os-pc",
	)
	if target != "os-pc" {
		t.Fatalf("SSH target = %q", target)
	}
}

func TestCodexListReportsPartialHostsAndThreadCompletionUsesIDs(t *testing.T) {
	dependencies := testMachineDirectoryDependencies()
	output := executeDirectoryCommand(t, newCodexListCommand(dependencies))
	for _, value := range []string{
		"Roadmap follow-up", "thread-123", "os-pc",
		"DotNaos/project-space", "Partial task inventory",
	} {
		if !strings.Contains(output, value) {
			t.Fatalf("Codex list missing %q:\n%s", value, output)
		}
	}

	target := codexTargetOptions{machineID: testPhysicalMachineID}
	completion := codexThreadCompletion(dependencies, &target)
	values, directive := completion(&cobra.Command{}, nil, "")
	if directive != cobra.ShellCompDirectiveNoFileComp ||
		len(values) != 1 ||
		!strings.HasPrefix(values[0], "thread-123\tRoadmap follow-up") ||
		!strings.Contains(values[0], "cached inventory") {
		t.Fatalf("completion = %#v, directive = %v", values, directive)
	}
}

func TestMachineCompletionFailsQuietly(t *testing.T) {
	dependencies := testMachineDirectoryDependencies()
	dependencies.ListMachines = func(
		context.Context,
		bool,
	) (machineDirectoryLoad[machinedirectory.MachinesResult], error) {
		return machineDirectoryLoad[machinedirectory.MachinesResult]{}, context.DeadlineExceeded
	}
	values, directive := machineNameCompletion(dependencies)(&cobra.Command{}, nil, "")
	if len(values) != 0 || directive != cobra.ShellCompDirectiveNoFileComp {
		t.Fatalf("completion = %#v, directive = %v", values, directive)
	}
}

func testMachineDirectoryDependencies() machineDirectoryDependencies {
	machines := machinedirectory.MachinesResult{
		CheckedAt: "2026-07-28T16:00:00Z",
		Failures: []machinedirectory.Failure{{
			MachineID: testPhysicalMachineID,
			Message:   "App Server evidence is stale.",
			Source:    "probe",
		}},
		Machines: []machinedirectory.Machine{{
			CodexAppServer: machinedirectory.Signal{State: "stale"},
			Connector: machinedirectory.ConnectorSignal{
				Signal:        machinedirectory.Signal{State: "unavailable"},
				Installations: []machinedirectory.Connector{},
			},
			Enrollment: machinedirectory.Signal{
				LastSeenAt: "2026-07-28T15:57:00Z",
				State:      "enrolled",
			},
			ID:   testPhysicalMachineID,
			Name: "os-pc",
			Platform: machinedirectory.Platform{
				Architectures:    []string{"amd64"},
				OperatingSystems: []string{"windows"},
			},
			SSH: machinedirectory.Signal{State: "available"},
			Tailscale: machinedirectory.Signal{
				LastSeenAt: "2026-07-28T15:59:00Z",
				State:      "reachable",
			},
		}},
		SchemaVersion: 1,
	}
	threads := machinedirectory.ThreadsResult{
		CheckedAt: "2026-07-28T16:00:00Z",
		Hosts: []machinedirectory.ThreadHost{
			{
				CheckedAt:      "2026-07-28T16:00:00Z",
				ConnectorID:    "connector-1",
				InventoryState: "stale",
				MachineID:      testPhysicalMachineID,
				MachineName:    "os-pc",
			},
		},
		Partial:       true,
		SchemaVersion: 1,
		Threads: []machinedirectory.Thread{{
			Archived:       false,
			ConnectorID:    "connector-1",
			ID:             "thread-123",
			InventoryState: "stale",
			Machine: struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			}{ID: testPhysicalMachineID, Name: "os-pc"},
			Repository: "DotNaos/project-space",
			State:      "idle",
			Title:      "Roadmap follow-up",
			UpdatedAt:  "2026-07-28T15:58:00Z",
		}},
	}
	return machineDirectoryDependencies{
		ListMachines: func(
			context.Context,
			bool,
		) (machineDirectoryLoad[machinedirectory.MachinesResult], error) {
			return machineDirectoryLoad[machinedirectory.MachinesResult]{
				Result: machines,
			}, nil
		},
		ListThreads: func(
			_ context.Context,
			_ machinedirectory.ThreadFilter,
			allowCache bool,
		) (machineDirectoryLoad[machinedirectory.ThreadsResult], error) {
			return machineDirectoryLoad[machinedirectory.ThreadsResult]{
				Cached: allowCache,
				Result: threads,
			}, nil
		},
		ResolveSSH: func(
			context.Context,
			string,
		) (machinedirectory.SSHResult, error) {
			result := machinedirectory.SSHResult{SchemaVersion: 1, Target: "os-pc"}
			result.Machine.ID = testPhysicalMachineID
			result.Machine.Name = "os-pc"
			return result, nil
		},
		RunSSH: func(string) error { return nil },
	}
}

func executeDirectoryCommand(
	t *testing.T,
	command *cobra.Command,
	args ...string,
) string {
	t.Helper()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs(args)
	if err := command.Execute(); err != nil {
		t.Fatalf("execute %s: %v\n%s", command.Name(), err, output.String())
	}
	return output.String()
}
