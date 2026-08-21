package computecontrol

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStatusUsesMachineAuthenticationAndIdempotency(t *testing.T) {
	const environmentID = "11111111-1111-4111-8111-111111111111"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/compute/control/status" || request.Method != http.MethodPost ||
			request.Header.Get("Authorization") != "Bearer token" ||
			request.Header.Get("X-Project-Machine-ID") != "machine-one" ||
			request.Header.Get("Idempotency-Key") != "operation-one" {
			t.Fatalf("request = %#v, headers = %#v", request.URL, request.Header)
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(response, `{
          "audit":{"actorId":"machine-one","actorKind":"machine","capability":"project_cli","completedAt":"2026-08-12T10:00:01Z","gatewayId":"gateway-one","operation":"status.v1","operationId":"operation-one","outcome":"succeeded","routeClass":"ssh_private_network","routeId":"22222222-2222-4222-8222-222222222222","targetEnvironmentId":"%s","targetIdentityRevision":"1:environment:test"},
          "replayed":false,
          "result":{"checkedAt":"2026-08-12T10:00:00Z","operation":"status.v1","operationId":"operation-one","schemaVersion":1,"state":"ready","targetIdentityRevision":"1:environment:test","type":"result"}
        }`, environmentID)
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "token", nil },
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	if client.httpClient.Timeout != 70*time.Second {
		t.Fatalf("client timeout = %s", client.httpClient.Timeout)
	}
	result, err := client.Status(context.Background(), StatusRequest{
		EnvironmentID: environmentID, OperationID: "operation-one",
	})
	if err != nil || result.Result.State != "ready" || result.Audit.TargetEnvironmentID != environmentID {
		t.Fatalf("result = %#v, err = %v", result, err)
	}
}

func TestStatusRejectsUnknownResponseFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(response, `{"replayed":false,"audit":{},"result":{},"secret":"no"}`)
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "token", nil },
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Status(context.Background(), StatusRequest{
		EnvironmentID: "11111111-1111-4111-8111-111111111111", OperationID: "operation-one",
	})
	if err != ErrInvalidResponse {
		t.Fatalf("error = %v", err)
	}
}

func TestLaunchWorkspaceRuntimeUsesTypedMachineBoundary(t *testing.T) {
	requestBody := WorkspaceRuntimeLaunchRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/compute/control/workspace-runtime/launch" ||
			request.Method != http.MethodPost || request.Header.Get("Authorization") != "Bearer token" ||
			request.Header.Get("X-Project-Machine-ID") != "machine-one" ||
			request.Header.Get("Idempotency-Key") != "bootstrap-one" {
			t.Fatalf("request = %#v, headers = %#v", request.URL, request.Header)
		}
		if err := json.NewDecoder(request.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{
          "replayed":false,
          "result":{"checkedAt":"2026-08-12T10:00:00Z","generation":"22222222-2222-4222-8222-222222222222","manifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","operation":"workspace-runtime.start.v1","operationId":"bootstrap-one","sourceHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"running","workspaceId":"33333333-3333-4333-8333-333333333333"}
        }`)
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "token", nil },
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	input := WorkspaceRuntimeLaunchRequest{
		Branch: "issue-648", Commit: strings.Repeat("a", 40),
		EnvironmentID:  "11111111-1111-4111-8111-111111111111",
		Generation:     "22222222-2222-4222-8222-222222222222",
		ManifestDigest: strings.Repeat("b", 64), Mode: "process",
		OperationID: "bootstrap-one", Profile: "inspection", RuntimeVersion: "0.5.0",
		WorkspaceID: "33333333-3333-4333-8333-333333333333",
	}
	result, err := client.LaunchWorkspaceRuntime(context.Background(), input)
	if err != nil || result.Result.State != "running" || requestBody != input {
		t.Fatalf("result = %#v, request = %#v, err = %v", result, requestBody, err)
	}
}

func TestPrepareClientOwnedWorkspaceRuntimeReturnsExactHostLaunchDescriptor(t *testing.T) {
	requestBody := WorkspaceRuntimeClientLaunchRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/compute/control/workspace-runtime/client-launch" ||
			request.Method != http.MethodPost || request.Header.Get("Authorization") != "Bearer token" ||
			request.Header.Get("X-Project-Machine-ID") != "machine-one" ||
			request.Header.Get("Idempotency-Key") != "client-bootstrap-one" {
			t.Fatalf("request = %#v, headers = %#v", request.URL, request.Header)
		}
		if err := json.NewDecoder(request.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(response, `{
          "branch":"%s","commit":"%s","controlTargetIdentityRevision":"7:environment:canonical","environmentId":"%s","generation":"%s","hostId":"%s",
          "manifestDigest":"%s","mode":"process","operation":"workspace-runtime.start.v1","operationId":"client-bootstrap-one",
          "profile":"codex","runtimeSessionCapabilities":["runtime.lifecycle","runtime.heartbeat"],
          "runtimeSessionEndpoint":"wss://projects.os-home.net/api/workspace-runtimes/socket",
          "runtimeSessionExpiresAt":"%s","runtimeSessionOwnerUserId":"owner-one",
          "runtimeSessionRequestedCapabilities":["runtime.codex.v1","runtime.control.v1"],
          "runtimeSessionToken":"%s","runtimeSessionVersion":"0.5.0","runtimeVersion":"0.5.0",
          "sourceHead":"%s","state":"ready","targetIdentityRevision":"7:environment:canonical",
          "workspaceId":"%s"}`,
			"issue-724", strings.Repeat("a", 40),
			"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333", strings.Repeat("b", 64),
			time.Now().Add(5*time.Minute).UTC().Format(time.RFC3339Nano), strings.Repeat("A", 43), strings.Repeat("a", 40),
			"44444444-4444-4444-8444-444444444444")
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(func(context.Context) (string, error) { return "token", nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	input := WorkspaceRuntimeClientLaunchRequest{
		Branch: "issue-724", Commit: strings.Repeat("a", 40),
		EnvironmentID: "11111111-1111-4111-8111-111111111111", Generation: "22222222-2222-4222-8222-222222222222",
		HostID: "33333333-3333-4333-8333-333333333333", ManifestDigest: strings.Repeat("b", 64), Mode: "process",
		OperationID: "client-bootstrap-one", Profile: "codex", RuntimeVersion: "0.5.0",
		TargetIdentityRevision: "7:environment:canonical", WorkspaceID: "44444444-4444-4444-8444-444444444444",
	}
	result, err := client.PrepareClientOwnedWorkspaceRuntime(context.Background(), input)
	if err != nil || requestBody != input || result.HostID != input.HostID ||
		result.TargetIdentityRevision != input.TargetIdentityRevision || result.ControlTargetIdentityRevision != "7:environment:canonical" || result.RuntimeSessionToken != strings.Repeat("A", 43) {
		t.Fatalf("result = %#v, request = %#v, err = %v", result, requestBody, err)
	}
}

func TestWorkspaceRuntimePresentationCapabilityNegotiation(t *testing.T) {
	capabilityResponse := `{"capabilities":["workspace-runtime-presentation.v1"],"schemaVersion":1}`
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/compute/control/workspace-runtime/capabilities" ||
			request.Method != http.MethodGet || request.Header.Get("Authorization") != "Bearer token" ||
			request.Header.Get("X-Project-Machine-ID") != "machine-one" {
			t.Fatalf("request = %#v, headers = %#v", request.URL, request.Header)
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, capabilityResponse)
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "token", nil },
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !client.SupportsWorkspaceRuntimePresentation(context.Background()) {
		t.Fatal("expected presentation capability")
	}
	capabilityResponse = `{"error":"Route not found."}`
	if client.SupportsWorkspaceRuntimePresentation(context.Background()) {
		t.Fatal("old or malformed server response must disable optional presentation fields")
	}
}

func TestLaunchWorkspaceRuntimeRejectsUnboundInputAndResponse(t *testing.T) {
	client, err := NewClient(Config{
		BaseURL: "https://projects.invalid", CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "token", nil },
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.LaunchWorkspaceRuntime(context.Background(), WorkspaceRuntimeLaunchRequest{})
	if err != ErrInvalidInput {
		t.Fatalf("error = %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(response, `{
          "replayed":false,
          "result":{"checkedAt":"2026-08-12T10:00:00Z","generation":"22222222-2222-4222-8222-222222222222","manifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","operation":"workspace-runtime.start.v1","operationId":"different-operation","sourceHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"running","workspaceId":"33333333-3333-4333-8333-333333333333"}
        }`)
	}))
	defer server.Close()
	client, err = NewClient(Config{
		BaseURL: server.URL, CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "token", nil },
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.LaunchWorkspaceRuntime(context.Background(), WorkspaceRuntimeLaunchRequest{
		Branch: "issue-648", Commit: strings.Repeat("a", 40),
		EnvironmentID:  "11111111-1111-4111-8111-111111111111",
		Generation:     "22222222-2222-4222-8222-222222222222",
		ManifestDigest: strings.Repeat("b", 64), Mode: "process",
		OperationID: "bootstrap-one", Profile: "codex", RuntimeVersion: "0.5.0",
		WorkspaceID: "33333333-3333-4333-8333-333333333333",
	})
	if err != ErrInvalidResponse {
		t.Fatalf("error = %v", err)
	}
}

func TestLaunchWorkspaceRuntimeAcceptsOptionalPresentationBinding(t *testing.T) {
	client, err := NewClient(Config{
		BaseURL: "https://projects.invalid", CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "token", nil },
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	valid := WorkspaceRuntimeLaunchRequest{
		Branch: "issue-717", Commit: strings.Repeat("a", 40),
		EnvironmentID: "11111111-1111-4111-8111-111111111111",
		Generation:    "22222222-2222-4222-8222-222222222222", ManifestDigest: strings.Repeat("b", 64),
		Mode: "process", OperationID: "bootstrap-presentation", Profile: "codex", RuntimeVersion: "0.5.0",
		WorkspaceID: "33333333-3333-4333-8333-333333333333",
	}
	valid.WorktreeOwnerThreadID = "44444444-4444-4444-8444-444444444444"
	if !validLaunchRequest(valid) {
		t.Fatal("an exact managed Worktree owner should be valid for presentation binding")
	}
	valid.WorktreeOwnerThreadID = "caller-selected-label"
	if _, err := client.LaunchWorkspaceRuntime(context.Background(), valid); err != ErrInvalidInput {
		t.Fatalf("error = %v", err)
	}
}
