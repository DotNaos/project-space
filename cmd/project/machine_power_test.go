package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machinepower"
)

type fakeMachinePowerAPI struct {
	requests []machinepower.Request
	status   func(context.Context) (machinepower.StatusResult, error)
	statuses []machinepower.StatusResult
}

func (fake *fakeMachinePowerAPI) Request(
	_ context.Context,
	request machinepower.Request,
) (machinepower.OperationResult, error) {
	fake.requests = append(fake.requests, request)
	return machinepower.OperationResult{
		APIVersion:     1,
		Dispatch:       machinepower.Dispatch{Attempted: true},
		Machine:        machinepower.Machine{ID: "machine-id", Name: "os-pc"},
		Message:        "Delivery attempted once.",
		OperationID:    request.OperationID,
		Provider:       machinepower.Provider{DeviceID: "jetkvm-id", Kind: "jetkvm-mqtt"},
		RequestedState: request.RequestedState,
		State:          "uncertain",
	}, nil
}

func (fake *fakeMachinePowerAPI) Status(
	ctx context.Context,
	_ machinepower.Selector,
) (machinepower.StatusResult, error) {
	if fake.status != nil {
		return fake.status(ctx)
	}
	if len(fake.statuses) == 0 {
		return machinepower.StatusResult{}, machinepower.ErrUnavailable
	}
	result := fake.statuses[0]
	fake.statuses = fake.statuses[1:]
	return result, nil
}

func TestMachinePowerOnWaitsForIndependentPhysicalConfirmation(t *testing.T) {
	physicalPower := true
	fake := &fakeMachinePowerAPI{statuses: []machinepower.StatusResult{{
		APIVersion: 1,
		Evidence: &machinepower.Evidence{
			CheckedAt: "2026-07-29T00:00:00Z", Fresh: true,
			JetKVMOnline: &physicalPower, PhysicalPower: &physicalPower,
			Source: "jetkvm-mqtt",
		},
		Machine:  machinepower.Machine{ID: "machine-id", Name: "os-pc"},
		Message:  "Physical power is on.",
		Provider: machinepower.Provider{DeviceID: "jetkvm-id", Kind: "jetkvm-mqtt"},
		State:    "online",
	}}}
	command := newMachinePowerCommand(machinePowerDependencies{
		LoadRuntime: func(context.Context) (machinePowerAPI, error) { return fake, nil },
		NewOperationID: func(string) (string, error) {
			return "machine-power:on:test", nil
		},
		PollInterval: time.Millisecond,
		Wait:         func(context.Context, time.Duration) error { return nil },
	})
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs([]string{"on", "--machine", "os-pc", "--format", "json"})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var result machinepower.OperationResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("decode output: %v\n%s", err, output.String())
	}
	if result.State != "confirmed-online" || len(fake.requests) != 1 {
		t.Fatalf("result = %#v requests=%d", result, len(fake.requests))
	}
}

func TestMachinePowerOnNoWaitReportsAttemptWithoutClaimingOnline(t *testing.T) {
	fake := &fakeMachinePowerAPI{}
	command := newMachinePowerCommand(machinePowerDependencies{
		LoadRuntime: func(context.Context) (machinePowerAPI, error) { return fake, nil },
		NewOperationID: func(string) (string, error) {
			return "machine-power:on:no-wait", nil
		},
		PollInterval: time.Millisecond,
		Wait:         func(context.Context, time.Duration) error { return nil },
	})
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs([]string{"on", "--machine", "os-pc", "--no-wait"})

	if err := command.Execute(); err == nil {
		t.Fatal("execute unexpectedly treated an unconfirmed attempt as success")
	}
	if got := output.String(); !strings.Contains(got, "uncertain") ||
		strings.Contains(got, "confirmed-online") ||
		strings.Contains(got, "confirmed-offline") {
		t.Fatalf("output = %q", got)
	}
}

func TestMachinePowerWaitTimeoutBoundsTheStatusRequest(t *testing.T) {
	fake := &fakeMachinePowerAPI{
		status: func(ctx context.Context) (machinepower.StatusResult, error) {
			<-ctx.Done()
			return machinepower.StatusResult{}, ctx.Err()
		},
	}
	started := time.Now()
	result := waitForMachinePower(
		context.Background(),
		fake,
		machinepower.Selector{PhysicalMachineName: "os-pc"},
		machinepower.OperationResult{
			APIVersion: 1,
			Dispatch:   machinepower.Dispatch{Attempted: true},
			State:      "uncertain",
		},
		20*time.Millisecond,
		machinePowerDependencies{
			PollInterval: time.Millisecond,
			Wait:         func(context.Context, time.Duration) error { return nil },
		},
	)

	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("wait exceeded bound: %v", elapsed)
	}
	if result.State != "uncertain" {
		t.Fatalf("state = %q", result.State)
	}
}
