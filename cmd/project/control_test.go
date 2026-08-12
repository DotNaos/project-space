package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/computecontrol"
	"github.com/DotNaos/project-space/internal/computeinventory"
	"github.com/DotNaos/project-space/internal/workspacerun"
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

func TestControlGatewayRunsWorkspaceLifecycleThroughTheSharedManager(t *testing.T) {
	previous := projectMachineClientVersion
	projectMachineClientVersion = "0.5.0-test"
	t.Cleanup(func() { projectMachineClientVersion = previous })
	const workspaceID = "123e4567-e89b-42d3-a456-426614174001"
	const commit = "0123456789abcdef0123456789abcdef01234567"
	const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	manager := &fakeWorkspaceRuntimeManager{result: workspacerun.Result{
		SchemaVersion: workspacerun.SchemaVersion, Operation: "start", Disposition: workspacerun.DispositionCreated,
		WorkspaceID: workspaceID, Generation: "123e4567-e89b-42d3-a456-426614174000",
		Directory: "/private/owned/worktree", Repository: "/private/repository", ManifestDigest: digest,
		SourceHead: commit, Mode: workspacerun.ModeProcess, State: workspacerun.StateRunning,
		CheckedAt: "2026-08-12T10:00:00Z",
	}}
	identity := controlTestIdentity()
	identity.Workspaces = map[string]string{workspaceID: "/private/owned/worktree"}
	request := fmt.Sprintf(`{"environmentId":"%s","expectedCliVersion":"0.5.0-test","expectedCommit":"%s","expectedManifestDigest":"%s","expectedProtocolVersion":1,"mode":"process","operation":"workspace-runtime.start.v1","operationId":"op-runtime-1","schemaVersion":1,"targetIdentityRevision":"%s","type":"operation","workspaceId":"%s"}`+"\n", identity.EnvironmentID, commit, digest, identity.TargetIdentityRevision, workspaceID)
	output := &bytes.Buffer{}
	if err := serveControlGatewayWithRuntime(strings.NewReader(request), output, identity, func() (workspaceRuntimeManager, error) {
		return manager, nil
	}); err != nil {
		t.Fatalf("serve Workspace runtime operation: %v", err)
	}
	if manager.operation != "start" || manager.directory != "/private/owned/worktree" ||
		manager.options.ExpectedWorkspaceID != workspaceID || manager.options.ExpectedCommit != commit || manager.options.ExpectedDigest != digest || !manager.options.TrustedGateway {
		t.Fatalf("shared manager dispatch = %#v", manager)
	}
	for _, forbidden := range []string{"/private/owned/worktree", "/private/repository", "ownershipToken", "localUrl", "secret"} {
		if strings.Contains(output.String(), forbidden) {
			t.Fatalf("gateway output exposed %q: %s", forbidden, output.String())
		}
	}
	var result controlWorkspaceRuntimeResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil || result.WorkspaceID != workspaceID ||
		result.Operation != "workspace-runtime.start.v1" || result.State != workspacerun.StateRunning {
		t.Fatalf("Workspace runtime gateway result = %#v, err = %v", result, err)
	}
}

func TestWorkspaceControlPassesAnAuthenticatedRuntimeSessionWithoutExposingItsToken(t *testing.T) {
	const workspaceID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const commit = "0123456789abcdef0123456789abcdef01234567"
	const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const generation = "123e4567-e89b-42d3-a456-426614174000"
	const sessionToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	identity := controlTestIdentity()
	identity.Workspaces = map[string]string{workspaceID: "/private/owned/worktree"}
	manager := &fakeWorkspaceRuntimeManager{result: workspacerun.Result{
		Operation: "start", WorkspaceID: workspaceID, Generation: generation,
		ManifestDigest: digest, SourceHead: commit, Mode: workspacerun.ModeProcess,
		State: workspacerun.StateRunning, CheckedAt: "2026-08-12T10:00:00Z",
	}}
	request := controlGatewayOperationRequest{
		EnvironmentID: identity.EnvironmentID,
		Operation:     "workspace-runtime.start.v1", OperationID: "runtime-session-start",
		WorkspaceID: workspaceID, ExpectedCommit: commit, ExpectedManifestDigest: digest,
		ExpectedBranch: "issue-625", ExpectedGeneration: generation,
		ExpectedRuntimeVersion: "0.5.0-test", Mode: string(workspacerun.ModeProcess),
		RuntimeSessionEndpoint: "wss://projects.os-home.net/api/workspace-runtimes/socket",
		RuntimeSessionToken:    sessionToken, RuntimeSessionExpiresAt: time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339),
		RuntimeSessionVersion:      "0.5.0-test",
		RuntimeSessionCapabilities: []string{"runtime.lifecycle", "runtime.heartbeat", "runtime.dev-servers"},
	}
	output := &bytes.Buffer{}
	if err := executeWorkspaceRuntimeControl(output, identity, request, func() (workspaceRuntimeManager, error) {
		return manager, nil
	}); err != nil {
		t.Fatal(err)
	}
	if manager.options.RuntimeSession == nil || manager.options.RuntimeSession.Token != sessionToken ||
		manager.options.RuntimeSession.EnvironmentID != identity.EnvironmentID ||
		manager.options.RuntimeSession.Endpoint != request.RuntimeSessionEndpoint ||
		manager.options.ExpectedBranch != request.ExpectedBranch {
		t.Fatalf("runtime session bootstrap = %#v", manager.options.RuntimeSession)
	}
	if strings.Contains(output.String(), sessionToken) || strings.Contains(output.String(), "runtimeSessionToken") {
		t.Fatalf("control result exposed runtime credential: %s", output.String())
	}
}

func TestWorkspaceControlRejectsMalformedRuntimeSessionBeforeStartingTheManager(t *testing.T) {
	const workspaceID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	identity := controlTestIdentity()
	identity.Workspaces = map[string]string{workspaceID: "/private/owned/worktree"}
	base := controlGatewayOperationRequest{
		Operation: "workspace-runtime.start.v1", OperationID: "runtime-session-start",
		WorkspaceID: workspaceID, ExpectedCommit: "0123456789abcdef0123456789abcdef01234567",
		ExpectedManifestDigest: strings.Repeat("a", 64), ExpectedGeneration: "123e4567-e89b-42d3-a456-426614174000",
		ExpectedBranch: "issue-625", ExpectedRuntimeVersion: "0.5.0-test",
		Mode: string(workspacerun.ModeProcess), RuntimeSessionEndpoint: "wss://projects.os-home.net/api/workspace-runtimes/socket",
		RuntimeSessionToken: strings.Repeat("A", 43), RuntimeSessionExpiresAt: time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339),
		RuntimeSessionVersion: "0.5.0-test", RuntimeSessionCapabilities: []string{"runtime.lifecycle", "runtime.heartbeat"},
	}
	invalid := []controlGatewayOperationRequest{
		func() controlGatewayOperationRequest {
			value := base
			value.RuntimeSessionEndpoint = "wss://projects.os-home.net/other"
			return value
		}(),
		func() controlGatewayOperationRequest {
			value := base
			value.RuntimeSessionToken = "short"
			return value
		}(),
		func() controlGatewayOperationRequest {
			value := base
			value.RuntimeSessionCapabilities = []string{"runtime.shell"}
			return value
		}(),
		func() controlGatewayOperationRequest {
			value := base
			value.RuntimeSessionCapabilities = []string{"runtime.codex.v1"}
			return value
		}(),
		func() controlGatewayOperationRequest {
			value := base
			value.RuntimeSessionRequestedCapabilities = []string{"runtime.codex.v1"}
			return value
		}(),
		func() controlGatewayOperationRequest {
			value := base
			value.RuntimeSessionRequestedCapabilities = []string{"runtime.shell"}
			value.RuntimeSessionOwnerUserID = "owner"
			return value
		}(),
		func() controlGatewayOperationRequest {
			value := base
			value.RuntimeSessionExpiresAt = time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
			return value
		}(),
		func() controlGatewayOperationRequest { value := base; value.RuntimeSessionToken = ""; return value }(),
	}
	for _, request := range invalid {
		called := false
		err := executeWorkspaceRuntimeControl(&bytes.Buffer{}, identity, request, func() (workspaceRuntimeManager, error) {
			called = true
			return &fakeWorkspaceRuntimeManager{}, nil
		})
		if err == nil || called {
			t.Fatalf("invalid runtime session reached manager: %#v error=%v called=%v", request, err, called)
		}
	}
	requested := base
	requested.RuntimeSessionRequestedCapabilities = []string{"runtime.codex.v1"}
	requested.RuntimeSessionOwnerUserID = "owner"
	if !validRuntimeSessionBootstrap(requested) {
		t.Fatal("bounded Codex promotion intent was rejected")
	}
}

func TestControlGatewayRejectsUnregisteredWorkspaceAndRemotePathInjection(t *testing.T) {
	previous := projectMachineClientVersion
	projectMachineClientVersion = "0.5.0-test"
	t.Cleanup(func() { projectMachineClientVersion = previous })
	identity := controlTestIdentity()
	identity.Workspaces = map[string]string{"123e4567-e89b-42d3-a456-426614174001": "/trusted/worktree"}
	input := `{"environmentId":"11111111-1111-4111-8111-111111111111","expectedCliVersion":"0.5.0-test","expectedCommit":"0123456789abcdef0123456789abcdef01234567","expectedManifestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedProtocolVersion":1,"mode":"process","operation":"workspace-runtime.start.v1","operationId":"op-runtime-1","path":"/tmp/foreign","schemaVersion":1,"targetIdentityRevision":"1:environment:test","type":"operation","workspaceId":"123e4567-e89b-42d3-a456-426614174099"}` + "\n"
	called := false
	err := serveControlGatewayWithRuntime(strings.NewReader(input), &bytes.Buffer{}, identity, func() (workspaceRuntimeManager, error) {
		called = true
		return &fakeWorkspaceRuntimeManager{}, nil
	})
	if err == nil || called {
		t.Fatalf("unregistered/path-injected Workspace reached manager: error=%v called=%v", err, called)
	}
}

func TestWorkspaceControlDispatchesEveryTypedLifecycleOperation(t *testing.T) {
	const workspaceID = "123e4567-e89b-42d3-a456-426614174001"
	const commit = "0123456789abcdef0123456789abcdef01234567"
	const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const generation = "123e4567-e89b-42d3-a456-426614174000"
	identity := controlTestIdentity()
	identity.Workspaces = map[string]string{workspaceID: "/private/owned/worktree"}
	for remoteOperation, localOperation := range workspaceControlOperations {
		t.Run(localOperation, func(t *testing.T) {
			expectedGeneration := generation
			if localOperation == "start" {
				expectedGeneration = ""
			}
			manager := &fakeWorkspaceRuntimeManager{result: workspacerun.Result{
				SchemaVersion: workspacerun.SchemaVersion, Operation: localOperation,
				WorkspaceID: workspaceID, Generation: generation, ManifestDigest: digest,
				SourceHead: commit, Mode: workspacerun.ModeProcess, State: workspacerun.StateRunning,
				CheckedAt: "2026-08-12T10:00:00Z",
			}}
			request := controlGatewayOperationRequest{
				EnvironmentID: identity.EnvironmentID, Operation: remoteOperation,
				OperationID: "operation-fixture", WorkspaceID: workspaceID,
				ExpectedCommit: commit, ExpectedManifestDigest: digest,
				ExpectedGeneration: expectedGeneration, Mode: string(workspacerun.ModeProcess),
			}
			if err := executeWorkspaceRuntimeControl(&bytes.Buffer{}, identity, request, func() (workspaceRuntimeManager, error) {
				return manager, nil
			}); err != nil {
				t.Fatal(err)
			}
			if manager.operation != localOperation || manager.options.ExpectedGeneration != expectedGeneration || !manager.options.TrustedGateway {
				t.Fatalf("dispatch = %#v", manager)
			}
		})
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
	if err != nil || json.Unmarshal(encoded, &loaded) != nil || !reflect.DeepEqual(loaded, changed) {
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
	identity := controlTestIdentity()
	serve := func() error { return serveControlGateway(os.Stdin, os.Stdout, identity) }
	if os.Getenv("PROJECT_CONTROL_GATEWAY_WORKSPACE_HELPER") == "1" {
		const workspaceID = "123e4567-e89b-42d3-a456-426614174001"
		const commit = "0123456789abcdef0123456789abcdef01234567"
		const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		identity.Workspaces = map[string]string{workspaceID: "/private/owned/worktree"}
		manager := &fakeWorkspaceRuntimeManager{result: workspacerun.Result{
			SchemaVersion: workspacerun.SchemaVersion, Operation: "start",
			Disposition: workspacerun.DispositionCreated, WorkspaceID: workspaceID,
			Generation: "123e4567-e89b-42d3-a456-426614174000", ManifestDigest: digest,
			SourceHead: commit, Mode: workspacerun.ModeProcess, State: workspacerun.StateRunning,
			CheckedAt: time.Now().UTC().Format(time.RFC3339Nano),
		}}
		serve = func() error {
			return serveControlGatewayWithRuntime(os.Stdin, os.Stdout, identity, func() (workspaceRuntimeManager, error) {
				return &contractWorkspaceRuntimeManager{fakeWorkspaceRuntimeManager: manager, expectedBranch: "issue-625"}, nil
			})
		}
	}
	if err := serve(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(0)
}

type contractWorkspaceRuntimeManager struct {
	*fakeWorkspaceRuntimeManager
	expectedBranch string
}

func (manager *contractWorkspaceRuntimeManager) Start(
	ctx context.Context,
	directory string,
	options workspacerun.OperationOptions,
	streams workspacerun.Streams,
) (workspacerun.Result, error) {
	if options.ExpectedBranch != manager.expectedBranch || options.RuntimeSession == nil ||
		options.RuntimeSession.RuntimeVersion != "0.5.0-test" ||
		options.RuntimeSession.OwnerUserID != "owner-one" ||
		!reflect.DeepEqual(options.RuntimeSession.RequestedCapabilities, []string{"runtime.control.v1"}) {
		return workspacerun.Result{}, fmt.Errorf("Workspace runtime authority was not transported")
	}
	return manager.fakeWorkspaceRuntimeManager.Start(ctx, directory, options, streams)
}
