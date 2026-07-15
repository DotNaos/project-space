package machineconnect

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPBackendUsesPrivatePollChannelAndMachineCredential(t *testing.T) {
	const (
		pollToken    = "private-poll-token"
		exchangeCode = "one-time-exchange-code"
		machineToken = "private-machine-credential"
		requestID    = "request-123"
		machineID    = "machine-123"
	)
	now := time.Now().UTC().Truncate(time.Second)
	var machinePublicKey ed25519.PublicKey
	var server *httptest.Server
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "GET /api/health":
			response.WriteHeader(http.StatusNoContent)
		case "POST /api/machine-connections":
			if request.Header.Get("Authorization") != "" {
				t.Errorf("create request unexpectedly had authorization")
			}
			var payload struct {
				ConnectorProfile *struct {
					Channel string `json:"channel"`
					Source  string `json:"source"`
				} `json:"connectorProfile"`
				Hostname        string `json:"hostname"`
				OperatingSystem string `json:"operatingSystem"`
				PublicKey       string `json:"publicKey"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Errorf("decode create payload: %v", err)
			}
			if payload.Hostname != "os-pc" || payload.OperatingSystem != "linux" {
				t.Errorf("unexpected machine: %#v", payload)
			}
			if payload.ConnectorProfile == nil || payload.ConnectorProfile.Channel != "dev" ||
				payload.ConnectorProfile.Source != "source" {
				t.Errorf("unexpected connector profile: %#v", payload.ConnectorProfile)
			}
			decodedPublicKey, err := base64.RawURLEncoding.DecodeString(payload.PublicKey)
			if err != nil || len(decodedPublicKey) != ed25519.PublicKeySize {
				t.Errorf("invalid public key: %q", payload.PublicKey)
			} else {
				machinePublicKey = decodedPublicKey
			}
			writeTestJSON(response, map[string]any{
				"requestId": requestID, "pollToken": pollToken,
				"approvalUrl": server.URL + "/connect/approve", "expiresAt": now.Add(time.Minute).Format(time.RFC3339),
				"pollIntervalMs": 500,
			})
		case "GET /api/machine-connections/" + requestID:
			assertBearer(t, request, pollToken)
			if strings.Contains(request.URL.String(), pollToken) {
				t.Error("poll token leaked into URL")
			}
			writeTestJSON(response, map[string]any{"status": "approved", "approvalChallenge": exchangeCode})
		case "POST /api/machine-connections/" + requestID + "/exchange":
			assertBearer(t, request, pollToken)
			var payload struct {
				Signature string `json:"signature"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Errorf("decode exchange payload: %v", err)
			}
			signature, err := base64.RawURLEncoding.DecodeString(payload.Signature)
			message := []byte("project-space-machine-connect:v1:" + requestID + ":" + exchangeCode)
			if err != nil || !ed25519.Verify(machinePublicKey, message, signature) {
				t.Errorf("machine approval signature is invalid")
			}
			writeTestJSON(response, map[string]any{
				"machineId": machineID, "machineName": "OS PC", "credential": machineToken,
				"issuedAt": now.Format(time.RFC3339),
			})
		case "GET /api/machines/" + machineID + "/connection":
			assertBearer(t, request, machineToken)
			writeTestJSON(response, map[string]string{"status": "online"})
		case "POST /api/machines/" + machineID + "/revoke":
			assertBearer(t, request, machineToken)
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	})
	server = httptest.NewServer(handler)
	defer server.Close()
	backend, err := NewHTTPBackend(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}
	ctx := context.Background()
	machineKey, err := GenerateMachineKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate machine key: %v", err)
	}
	if err := backend.Health(ctx); err != nil {
		t.Fatalf("health: %v", err)
	}
	machine := testMachine()
	machine.Channel = "dev"
	machine.Source = "source"
	connectionRequest, err := backend.CreateRequest(ctx, machine, machineKey)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	if connectionRequest.ID != requestID || connectionRequest.PollToken != pollToken {
		t.Fatalf("unexpected request: %#v", connectionRequest)
	}
	approval, err := backend.PollRequest(ctx, connectionRequest)
	if err != nil {
		t.Fatalf("poll request: %v", err)
	}
	credential, err := backend.Exchange(ctx, connectionRequest, approval.Challenge, machineKey)
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if credential.Token != machineToken || credential.BackendURL != server.URL {
		t.Fatalf("unexpected credential: %#v", credential)
	}
	state, err := backend.Connection(ctx, credential)
	if err != nil || state != ConnectionOnline {
		t.Fatalf("connection: state=%q err=%v", state, err)
	}
	if err := backend.Revoke(ctx, credential); err != nil {
		t.Fatalf("revoke: %v", err)
	}
}

func TestHTTPBackendDoesNotLeakSensitiveErrorBodies(t *testing.T) {
	const secret = "never-print-this-poll-token"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprintf(response, `{"error":"token %s rejected"}`, secret)
	}))
	defer server.Close()
	backend, err := NewHTTPBackend(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}
	_, err = backend.PollRequest(context.Background(), Request{ID: "request-1", PollToken: secret})
	if err == nil {
		t.Fatal("expected poll to fail")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "token ") {
		t.Fatalf("sensitive backend body leaked into error: %v", err)
	}
}

func TestHTTPBackendRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"padding":"` + strings.Repeat("x", maxResponseBytes) + `"}`))
	}))
	defer server.Close()
	backend, err := NewHTTPBackend(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}
	_, err = backend.CreateRequest(context.Background(), testMachine(), testMachineKey(t))
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("expected bounded response error, got %v", err)
	}
}

func TestHTTPBackendDoesNotFollowRedirects(t *testing.T) {
	followed := false
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/redirect-target" {
			followed = true
			response.WriteHeader(http.StatusNoContent)
			return
		}
		http.Redirect(response, request, "/redirect-target", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	backend, err := NewHTTPBackend(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}
	if err := backend.Health(context.Background()); err == nil {
		t.Fatal("expected redirect to be rejected")
	}
	if followed {
		t.Fatal("backend client followed a redirect")
	}
}

func TestHTTPBackendRejectsRemotePlainHTTP(t *testing.T) {
	if _, err := NewHTTPBackend("http://projects.example.test", nil); err == nil ||
		!strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("expected remote HTTP backend to be rejected, got %v", err)
	}
}

func TestHTTPBackendRejectsCrossOriginApprovalURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/machine-connections" {
			http.NotFound(response, request)
			return
		}
		writeTestJSON(response, map[string]any{
			"requestId": "request-1", "pollToken": "poll-token",
			"approvalUrl": "https://attacker.example/connect", "expiresAt": time.Now().Add(time.Minute).Format(time.RFC3339),
		})
	}))
	defer server.Close()
	backend, err := NewHTTPBackend(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}
	if _, err := backend.CreateRequest(context.Background(), testMachine(), testMachineKey(t)); err == nil ||
		!strings.Contains(err.Error(), "cross-origin") {
		t.Fatalf("expected cross-origin approval URL to be rejected, got %v", err)
	}
}

func assertBearer(t *testing.T, request *http.Request, token string) {
	t.Helper()
	if authorization := request.Header.Get("Authorization"); authorization != "Bearer "+token {
		t.Errorf("authorization = %q, want bearer credential", authorization)
	}
}

func writeTestJSON(response http.ResponseWriter, payload any) {
	_ = json.NewEncoder(response).Encode(payload)
}
