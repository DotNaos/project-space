package machinereadiness

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientDiagnosisAndFixKeepAuthenticationSelectorsAndPlanExact(t *testing.T) {
	requests := make(chan *http.Request, 2)
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests <- request.Clone(request.Context())
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodGet {
			_ = json.NewEncoder(writer).Encode(resultFixture(StateRepairable))
			return
		}
		var body FixRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode fix body: %v", err)
		}
		result := FixResult{
			APIVersion:  APIVersion,
			Diagnosis:   resultFixture(StateRepairing),
			OperationID: body.OperationID,
			State:       "repairing",
		}
		_ = json.NewEncoder(writer).Encode(result)
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL:         server.URL,
		CallerMachineID: "caller-machine",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "machine-token", nil },
		),
	})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	selector := Selector{
		ConnectorID:         "linux-stable",
		PhysicalMachineName: "os-pc",
	}
	if _, err := client.Diagnose(context.Background(), selector); err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	get := <-requests
	if get.URL.Query().Get("physicalMachineName") != "os-pc" ||
		get.URL.Query().Get("connectorId") != "linux-stable" ||
		get.Header.Get("Authorization") != "Bearer machine-token" ||
		get.Header.Get("X-Project-Machine-ID") != "caller-machine" {
		t.Fatalf("diagnosis request = %#v headers=%#v", get.URL, get.Header)
	}
	fixed, err := client.Fix(context.Background(), FixRequest{
		Selector:    selector,
		OperationID: "doctor:one",
		PlanID:      strings.Repeat("a", 64),
	})
	if err != nil || fixed.State != "repairing" {
		t.Fatalf("fix = %#v, %v", fixed, err)
	}
	post := <-requests
	if post.Header.Get("Idempotency-Key") != "doctor:one" {
		t.Fatalf("idempotency header = %q", post.Header.Get("Idempotency-Key"))
	}
}

func TestClientRejectsUnauthorizedAndInvalidResponses(t *testing.T) {
	for _, test := range []struct {
		name string
		code int
		body string
		want error
	}{
		{name: "unauthorized", code: http.StatusForbidden, body: `{}`, want: ErrUnauthorized},
		{name: "invalid", code: http.StatusOK, body: `{"apiVersion":99}`, want: ErrInvalidResponse},
		{name: "unavailable", code: http.StatusServiceUnavailable, body: `{}`, want: ErrUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(
				writer http.ResponseWriter,
				_ *http.Request,
			) {
				writer.WriteHeader(test.code)
				_, _ = writer.Write([]byte(test.body))
			}))
			defer server.Close()
			client, err := NewClient(Config{
				BaseURL:         server.URL,
				CallerMachineID: "caller",
				CredentialProvider: CredentialProviderFunc(
					func(context.Context) (string, error) { return "token", nil },
				),
			})
			if err != nil {
				t.Fatalf("client: %v", err)
			}
			_, err = client.Diagnose(
				context.Background(),
				Selector{PhysicalMachineName: "os-pc"},
			)
			if err != test.want {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestCodexDaemonEvidenceRejectsContradictoryReadyState(t *testing.T) {
	evidence := CodexDaemonEvidence{
		Authenticated:        true,
		CheckedAt:            "2026-07-24T00:00:00.000Z",
		Compatible:           true,
		EnvironmentID:        "env_os_pc",
		Installed:            true,
		Paired:               true,
		Reachable:            true,
		RemoteControlEnabled: true,
		RemoteControlState:   "connected",
		Running:              true,
		State:                "ready",
	}
	if !validCodexDaemonEvidence(evidence) {
		t.Fatal("complete ready evidence was rejected")
	}
	if codexDaemonResultState(evidence) != "completed" {
		t.Fatal("ready evidence did not require a completed result")
	}
	evidence.Authenticated = false
	if validCodexDaemonEvidence(evidence) {
		t.Fatal("contradictory ready evidence was accepted")
	}
}

func resultFixture(state State) Result {
	return Result{
		APIVersion: APIVersion,
		CheckedAt:  "2026-07-24T00:00:00.000Z",
		Message:    "Fixture readiness.",
		State:      state,
	}
}
