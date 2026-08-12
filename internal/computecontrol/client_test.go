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
		OperationID: "bootstrap-one", RuntimeVersion: "0.5.0",
		WorkspaceID: "33333333-3333-4333-8333-333333333333",
	}
	result, err := client.LaunchWorkspaceRuntime(context.Background(), input)
	if err != nil || result.Result.State != "running" || requestBody != input {
		t.Fatalf("result = %#v, request = %#v, err = %v", result, requestBody, err)
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
		OperationID: "bootstrap-one", RuntimeVersion: "0.5.0",
		WorkspaceID: "33333333-3333-4333-8333-333333333333",
	})
	if err != ErrInvalidResponse {
		t.Fatalf("error = %v", err)
	}
}
