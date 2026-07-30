package machinepower

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientKeepsAuthenticationIdentityAndIdempotencyExact(t *testing.T) {
	requests := make(chan *http.Request, 2)
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests <- request.Clone(request.Context())
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodGet {
			_ = json.NewEncoder(writer).Encode(StatusResult{
				APIVersion: APIVersion,
				Machine:    Machine{ID: "machine-id", Name: "os-pc"},
				Message:    "Physical power is off.",
				Provider:   Provider{DeviceID: "jetkvm-id", Kind: "jetkvm-mqtt"},
				State:      "offline",
			})
			return
		}
		var input Request
		_ = json.NewDecoder(request.Body).Decode(&input)
		_ = json.NewEncoder(writer).Encode(OperationResult{
			APIVersion:     APIVersion,
			Dispatch:       Dispatch{Attempted: true, BrokerAcknowledged: true},
			Machine:        Machine{ID: "machine-id", Name: "os-pc"},
			Message:        "Accepted once.",
			OperationID:    input.OperationID,
			Provider:       Provider{DeviceID: "jetkvm-id", Kind: "jetkvm-mqtt"},
			RequestedState: input.RequestedState,
			State:          "accepted",
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{
		BaseURL:         server.URL,
		CallerMachineID: "caller",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "machine-token", nil },
		),
	})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	selector := Selector{PhysicalMachineName: "os-pc"}
	if _, err := client.Status(context.Background(), selector); err != nil {
		t.Fatalf("status: %v", err)
	}
	get := <-requests
	if get.URL.Query().Get("physicalMachineName") != "os-pc" ||
		get.Header.Get("Authorization") != "Bearer machine-token" ||
		get.Header.Get("X-Project-Machine-ID") != "caller" {
		t.Fatalf("status request = %#v headers=%#v", get.URL, get.Header)
	}
	if _, err := client.Request(context.Background(), Request{
		Selector: selector, OperationID: "machine-power:on:test", RequestedState: "on",
	}); err != nil {
		t.Fatalf("request: %v", err)
	}
	post := <-requests
	if post.Header.Get("Idempotency-Key") != "machine-power:on:test" {
		t.Fatalf("idempotency key = %q", post.Header.Get("Idempotency-Key"))
	}
}

func TestClientRejectsContradictoryResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"apiVersion":1,"state":"online"}`))
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
	if _, err := client.Status(
		context.Background(),
		Selector{PhysicalMachineName: "os-pc"},
	); err != ErrInvalidResponse {
		t.Fatalf("error = %v, want %v", err, ErrInvalidResponse)
	}
}
