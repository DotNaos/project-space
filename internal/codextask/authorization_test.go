package codextask

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientAuthorizationUsesExactConstrainedRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodPost ||
			request.URL.Path != authorizationPath ||
			request.Header.Get("Idempotency-Key") != testOperationID ||
			request.Header.Get("Authorization") != "Bearer caller-secret" {
			t.Fatalf("request = %s %s headers=%#v", request.Method, request.URL.Path, request.Header)
		}
		var input AuthorizationRequest
		if json.NewDecoder(request.Body).Decode(&input) != nil ||
			input.Action != AuthorizationStart ||
			input.PhysicalMachineName != "os-pc" ||
			input.ConnectorID != "connector-remote" {
			t.Fatalf("input = %#v", input)
		}
		target := testTarget()
		target.PhysicalMachine.Name = "os-pc"
		writeTestJSON(t, response, AuthorizationResult{
			APIVersion:      APIVersion,
			DeadlineAt:      "2026-07-24T00:15:00Z",
			Message:         "Open the verification page and enter the device code.",
			OperationID:     testOperationID,
			State:           AuthorizationPending,
			Target:          target,
			UserCode:        "ABCD-1234",
			VerificationURL: "https://auth.openai.com/codex/device",
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{})
	result, err := client.Authorize(context.Background(), AuthorizationRequest{
		Selector: Selector{
			ConnectorID:         "connector-remote",
			PhysicalMachineName: "os-pc",
		},
		Action:      AuthorizationStart,
		OperationID: testOperationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.State != AuthorizationPending ||
		result.UserCode != "ABCD-1234" ||
		result.VerificationURL != "https://auth.openai.com/codex/device" {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientAuthorizationRejectsUntrustedVerificationURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		target := testTarget()
		target.PhysicalMachine.Name = "os-pc"
		writeTestJSON(t, response, AuthorizationResult{
			APIVersion:      APIVersion,
			DeadlineAt:      "2026-07-24T00:15:00Z",
			Message:         "Pending.",
			OperationID:     testOperationID,
			State:           AuthorizationPending,
			Target:          target,
			UserCode:        "ABCD-1234",
			VerificationURL: "https://attacker.example/codex/device?token=secret",
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{})
	if _, err := client.Authorize(context.Background(), AuthorizationRequest{
		Selector:    Selector{PhysicalMachineName: "os-pc"},
		Action:      AuthorizationStart,
		OperationID: testOperationID,
	}); err != ErrInvalidResponse {
		t.Fatalf("error = %v", err)
	}
}
