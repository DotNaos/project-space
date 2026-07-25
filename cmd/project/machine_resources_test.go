package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/machineresources"
)

type fakeMachineResourcesAPI struct {
	calls   int
	results []machineresources.Result
}

func (fake *fakeMachineResourcesAPI) List(context.Context) (machineresources.Result, error) {
	if len(fake.results) == 0 {
		return machineresources.Result{}, errors.New("no fake result")
	}
	index := fake.calls
	if index >= len(fake.results) {
		index = len(fake.results) - 1
	}
	fake.calls++
	return fake.results[index], nil
}

func TestMachineResourcesListPrintsHonestOverview(t *testing.T) {
	api := &fakeMachineResourcesAPI{results: []machineresources.Result{machineResourcesFixture()}}
	command := newMachineResourcesCommand(machineResourcesDependencies(api))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"list"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	for _, value := range []string{
		"MACHINE", "Workstation", "Stable", "42%", "8.0 GiB / 16.0 GiB",
		"unsupported (No supported GPU provider)",
	} {
		if !strings.Contains(output.String(), value) {
			t.Errorf("output does not contain %q:\n%s", value, output.String())
		}
	}
}

func TestMachineResourcesShowRequiresContextWhenMachineHasSeveral(t *testing.T) {
	api := &fakeMachineResourcesAPI{results: []machineresources.Result{machineResourcesFixture()}}
	command := newMachineResourcesCommand(machineResourcesDependencies(api))
	command.SetArgs([]string{"show", "--machine", "Workstation"})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "multiple contexts") {
		t.Fatalf("error = %v", err)
	}
}

func TestMachineResourcesShowSelectsContextByLabel(t *testing.T) {
	api := &fakeMachineResourcesAPI{results: []machineresources.Result{machineResourcesFixture()}}
	command := newMachineResourcesCommand(machineResourcesDependencies(api))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"show", "--machine", "Workstation", "--context", "dev", "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var result machineresources.Result
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if len(result.Machines) != 1 || result.Machines[0].Context.ID != "context-dev" {
		t.Fatalf("result = %#v", result)
	}
}

func TestMachineResourcesShowHereUsesCredentialMachineID(t *testing.T) {
	fixture := machineResourcesFixture()
	api := &fakeMachineResourcesAPI{results: []machineresources.Result{fixture}}
	dependencies := machineResourcesDependencies(api)
	dependencies.LoadRuntime = func(context.Context) (machineResourcesRuntime, error) {
		return machineResourcesRuntime{
			api: api, credential: machineconnect.Credential{MachineID: "connector-stable"},
		}, nil
	}
	command := newMachineResourcesCommand(dependencies)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"show", "--here"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(output.String(), "Context:  Stable") {
		t.Fatalf("output = %q", output.String())
	}
}

func TestMachineResourcesWatchJSONEmitsOneSnapshotPerLine(t *testing.T) {
	first := machineResourcesFixture()
	second := machineResourcesFixture()
	value := 73.0
	second.CheckedAt = "2026-07-25T04:00:02Z"
	second.Machines[0].Metrics.CPU.UtilizationPercent = &value
	api := &fakeMachineResourcesAPI{results: []machineresources.Result{first, second}}
	dependencies := machineResourcesDependencies(api)
	waits := 0
	dependencies.Wait = func(context.Context, time.Duration) error {
		waits++
		if waits == 2 {
			return context.Canceled
		}
		return nil
	}
	command := newMachineResourcesCommand(dependencies)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"watch", "--here", "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("JSON lines = %d, output:\n%s", len(lines), output.String())
	}
	for _, line := range lines {
		var result machineresources.Result
		if err := json.Unmarshal([]byte(line), &result); err != nil {
			t.Fatalf("invalid JSON line %q: %v", line, err)
		}
	}
}

func TestMachineResourcesTargetFlagsAreExclusive(t *testing.T) {
	api := &fakeMachineResourcesAPI{results: []machineresources.Result{machineResourcesFixture()}}
	command := newMachineResourcesCommand(machineResourcesDependencies(api))
	command.SetArgs([]string{"show", "--here", "--machine", "Workstation"})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "cannot be used together") {
		t.Fatalf("error = %v", err)
	}
}

func machineResourcesDependencies(api machineresources.API) machineResourcesCommandDependencies {
	return machineResourcesCommandDependencies{
		LoadRuntime: func(context.Context) (machineResourcesRuntime, error) {
			return machineResourcesRuntime{
				api: api, credential: machineconnect.Credential{MachineID: "connector-stable"},
			}, nil
		},
	}
}

func machineResourcesFixture() machineresources.Result {
	cpu, memoryUsed, memoryTotal := 42.0, int64(8<<30), int64(16<<30)
	diskUsed, diskTotal := int64(100<<30), int64(500<<30)
	stable := machineresources.Machine{
		MachineID: "connector-stable", MachineName: "Workstation Stable",
		PhysicalMachineID: "physical-1", PhysicalMachineName: "Workstation",
		Context: machineresources.Context{ID: "context-stable", Label: "Stable"},
		State:   machineresources.StatePartial, SampledAt: "2026-07-25T03:59:59Z",
		Metrics: machineresources.Metrics{
			CPU: machineresources.Metric{
				State: machineresources.MetricAvailable, UtilizationPercent: &cpu,
			},
			Memory: machineresources.Metric{
				State: machineresources.MetricAvailable, UsedBytes: &memoryUsed, TotalBytes: &memoryTotal,
			},
			Disk: machineresources.Metric{
				State: machineresources.MetricAvailable, UsedBytes: &diskUsed, TotalBytes: &diskTotal,
			},
			GPU: machineresources.Metric{
				State: machineresources.MetricUnsupported, Message: "No supported GPU provider",
			},
		},
	}
	dev := stable
	dev.MachineID = "connector-dev"
	dev.MachineName = "Workstation Dev"
	dev.Context = machineresources.Context{ID: "context-dev", Label: "Dev"}
	return machineresources.Result{
		CheckedAt: "2026-07-25T04:00:00Z",
		Machines:  []machineresources.Machine{stable, dev},
	}
}
