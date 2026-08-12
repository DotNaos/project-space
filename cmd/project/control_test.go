package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/computecontrol"
	"github.com/DotNaos/project-space/internal/computeinventory"
)

func TestControlHandshakeAndStatusAreTypedJSON(t *testing.T) {
	previous := projectMachineClientVersion
	projectMachineClientVersion = "0.5.0-test"
	t.Cleanup(func() { projectMachineClientVersion = previous })
	for _, test := range []struct {
		args      []string
		operation string
	}{
		{[]string{"control", "handshake"}, ""},
	} {
		command := newRootCommand()
		output := &bytes.Buffer{}
		command.SetOut(output)
		command.SetArgs(test.args)
		if err := command.Execute(); err != nil {
			t.Fatalf("execute %v: %v", test.args, err)
		}
		var result map[string]any
		if err := json.Unmarshal(output.Bytes(), &result); err != nil {
			t.Fatalf("decode %v: %v", test.args, err)
		}
		if result["schemaVersion"] != float64(1) {
			t.Fatalf("result = %#v", result)
		}
		if test.operation != "" && result["operation"] != test.operation {
			t.Fatalf("result = %#v", result)
		}
	}
}

type fakeComputeControlAPI struct {
	request computecontrol.StatusRequest
}

func (api *fakeComputeControlAPI) Status(
	_ context.Context,
	request computecontrol.StatusRequest,
) (computecontrol.ExecutionResult, error) {
	api.request = request
	return computecontrol.ExecutionResult{
		Audit: computecontrol.AuditEvidence{
			ActorID: "machine-one", ActorKind: "machine", Capability: "project_cli",
			GatewayID: "gateway-one", Operation: "status.v1", OperationID: request.OperationID,
			Outcome: "succeeded", RouteClass: "ssh_private_network",
			RouteID:                "22222222-2222-4222-8222-222222222222",
			TargetEnvironmentID:    request.EnvironmentID,
			TargetIdentityRevision: "1:environment:test",
		},
		Result: computecontrol.StatusResult{
			CheckedAt: "2026-08-12T10:00:00Z", Operation: "status.v1",
			OperationID: request.OperationID, SchemaVersion: 1, State: "ready",
			TargetIdentityRevision: "1:environment:test", Type: "result",
		},
	}, nil
}

func TestControlStatusResolvesOneEnvironmentAndCallsTheRemoteGateway(t *testing.T) {
	const environmentID = "11111111-1111-4111-8111-111111111111"
	inventory := &fakeComputeInventoryAPI{value: computeinventory.Inventory{
		EnvironmentInstances: []computeinventory.EnvironmentInstance{{
			Alias: "target", ID: environmentID, Reference: "platform/host/target",
		}},
	}}
	control := &fakeComputeControlAPI{}
	command := newControlCommandWithDependencies(controlCommandDependencies{
		Inventory:      inventoryDependencies(inventory),
		Load:           func(context.Context) (computecontrol.API, error) { return control, nil },
		NewOperationID: func(string) (string, error) { return "operation-one", nil },
	})
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"status", "target", "--json"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if control.request.EnvironmentID != environmentID || control.request.OperationID != "operation-one" {
		t.Fatalf("request = %#v", control.request)
	}
	var result computecontrol.ExecutionResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil || result.Result.State != "ready" {
		t.Fatalf("output = %s, err = %v", output.String(), err)
	}
}

func TestControlGatewayBindsTypedStatusResult(t *testing.T) {
	previous := projectMachineClientVersion
	projectMachineClientVersion = "0.5.0-test"
	t.Cleanup(func() { projectMachineClientVersion = previous })
	handshake := &bytes.Buffer{}
	if err := serveControlGateway(
		strings.NewReader(`{"schemaVersion":1,"type":"handshake"}`+"\n"), handshake,
		controlTestIdentity(),
	); err != nil {
		t.Fatalf("serve handshake: %v", err)
	}
	var handshakeResult map[string]any
	if err := json.Unmarshal(handshake.Bytes(), &handshakeResult); err != nil ||
		handshakeResult["cliVersion"] != "0.5.0-test" {
		t.Fatalf("handshake = %s, err = %v", handshake.String(), err)
	}
	operation := `{"environmentId":"11111111-1111-4111-8111-111111111111","expectedCliVersion":"0.5.0-test","expectedProtocolVersion":1,"operation":"status.v1","operationId":"op-1","schemaVersion":1,"targetIdentityRevision":"1:environment:test","type":"operation"}` + "\n"
	output := &bytes.Buffer{}
	if err := serveControlGateway(strings.NewReader(operation), output, controlTestIdentity()); err != nil {
		t.Fatalf("serve operation: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["operationId"] != "op-1" ||
		result["targetIdentityRevision"] != "1:environment:test" {
		t.Fatalf("result = %#v", result)
	}
}

func TestControlGatewayRejectsUnknownAndFreeFormOperations(t *testing.T) {
	for _, input := range []string{
		`{"schemaVersion":1,"type":"handshake","secret":"no"}` + "\n",
		`{"schemaVersion":1,"type":"handshake"}` + "\n" +
			`{"environmentId":"env","operation":"shell","operationId":"op","schemaVersion":1,"targetIdentityRevision":"revision","type":"operation"}` + "\n",
		`{"schemaVersion":1,"type":"handshake"}` + "\n" +
			`{"environmentId":"../escape","operation":"status.v1","operationId":"op with spaces","schemaVersion":1,"targetIdentityRevision":"short","type":"operation"}` + "\n",
		`{"environmentId":"11111111-1111-4111-8111-111111111111","expectedCliVersion":"0.4.0","expectedProtocolVersion":1,"operation":"status.v1","operationId":"op-1","schemaVersion":1,"targetIdentityRevision":"1:environment:test","type":"operation"}` + "\n",
	} {
		if err := serveControlGateway(strings.NewReader(input), &bytes.Buffer{}, controlTestIdentity()); err == nil {
			t.Fatalf("expected input to fail: %s", input)
		}
	}
}

func TestControlGatewayRejectsARequestedIdentityThatIsNotInstalled(t *testing.T) {
	operation := `{"environmentId":"11111111-1111-4111-8111-111111111111","expectedCliVersion":"0.5.0-test","expectedProtocolVersion":1,"operation":"status.v1","operationId":"op-1","schemaVersion":1,"targetIdentityRevision":"1:environment:other","type":"operation"}` + "\n"
	previous := projectMachineClientVersion
	projectMachineClientVersion = "0.5.0-test"
	t.Cleanup(func() { projectMachineClientVersion = previous })
	if err := serveControlGateway(
		strings.NewReader(operation), &bytes.Buffer{}, controlTestIdentity(),
	); err == nil {
		t.Fatal("expected uninstalled identity to fail")
	}
}

func controlTestIdentity() controlGatewayIdentity {
	return controlGatewayIdentity{
		EnvironmentID:          "11111111-1111-4111-8111-111111111111",
		TargetIdentityRevision: "1:environment:test",
	}
}

func TestWriteControlGatewayIdentityIsAtomicIdempotentAndExplicitOnReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "project-space", "environment-identity.json")
	identity := controlTestIdentity()
	if err := writeControlGatewayIdentity(path, identity, false); err != nil {
		t.Fatalf("write identity: %v", err)
	}
	if err := writeControlGatewayIdentity(path, identity, false); err != nil {
		t.Fatalf("idempotent write: %v", err)
	}
	changed := identity
	changed.TargetIdentityRevision = "2:environment:test"
	if err := writeControlGatewayIdentity(path, changed, false); err == nil {
		t.Fatal("expected replacement to require an explicit flag")
	}
	if err := writeControlGatewayIdentity(path, changed, true); err != nil {
		t.Fatalf("replace identity: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat identity: %v", err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("identity mode = %v", info.Mode().Perm())
	}
	loaded := controlGatewayIdentity{}
	encoded, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(encoded, &loaded) != nil || loaded != changed {
		t.Fatalf("loaded identity = %#v, err = %v", loaded, err)
	}
	linked := filepath.Join(t.TempDir(), "linked-identity.json")
	if err := os.WriteFile(linked, encoded, 0600); err != nil {
		t.Fatalf("write linked identity: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove installed identity: %v", err)
	}
	if err := os.Symlink(linked, path); err != nil {
		t.Fatalf("link identity: %v", err)
	}
	if err := writeControlGatewayIdentity(path, changed, true); err == nil {
		t.Fatal("expected a linked identity to be rejected")
	}
}

func TestControlGatewayContractProcess(t *testing.T) {
	if os.Getenv("PROJECT_CONTROL_GATEWAY_CONTRACT_HELPER") != "1" {
		return
	}
	if err := serveControlGateway(os.Stdin, os.Stdout, controlTestIdentity()); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(0)
}
