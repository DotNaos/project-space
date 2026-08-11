package computeinventory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientLoadsAuthenticatedInventoryAndSortsIt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/compute/inventory" {
			t.Fatalf("request = %s %s", request.Method, request.URL.String())
		}
		if request.Header.Get("Authorization") != "Bearer machine-token" ||
			request.Header.Get("X-Project-Machine-ID") != "machine-one" {
			t.Fatalf("headers = %#v", request.Header)
		}
		_ = json.NewEncoder(response).Encode(testInventory())
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	inventory, err := client.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if inventory.Platforms[0].ID != "platform-a" ||
		inventory.EnvironmentInstances[0].Reference != "platform-a/provider/environment-a" {
		t.Fatalf("inventory was not sorted: %#v", inventory)
	}
}

func TestClientRejectsMalformedUnknownOversizedAndWrongVersionResponses(t *testing.T) {
	handlers := []http.HandlerFunc{
		func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write([]byte("{")) },
		func(response http.ResponseWriter, _ *http.Request) {
			inventory := testInventory()
			inventory.SchemaVersion = 2
			_ = json.NewEncoder(response).Encode(inventory)
		},
		func(response http.ResponseWriter, _ *http.Request) {
			inventory := testInventory()
			inventory.EnvironmentInstances[0].HostResolution = "invented-resolution"
			_ = json.NewEncoder(response).Encode(inventory)
		},
		func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write([]byte(`{"schemaVersion":1,"unknown":true}`))
		},
		func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write([]byte(`{"padding":"` + strings.Repeat("x", int(maximumResponseBytes)) + `"}`))
		},
	}
	for index, handler := range handlers {
		server := httptest.NewServer(handler)
		_, err := testClient(t, server.URL).List(context.Background())
		server.Close()
		if !errors.Is(err, ErrInvalidResponse) {
			t.Fatalf("case %d error = %v", index, err)
		}
	}
}

func TestClientClassifiesAuthorizationAndAvailabilityFailures(t *testing.T) {
	for _, test := range []struct {
		status   int
		expected error
	}{
		{http.StatusUnauthorized, ErrUnauthorized},
		{http.StatusForbidden, ErrUnauthorized},
		{http.StatusServiceUnavailable, ErrUnavailable},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(test.status)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"error": map[string]string{"code": "inventory_unavailable", "message": "Inventory unavailable."},
			})
		}))
		_, err := testClient(t, server.URL).List(context.Background())
		server.Close()
		if !errors.Is(err, test.expected) {
			t.Fatalf("status %d error = %v", test.status, err)
		}
	}
}

func TestClientKeepsConflictInventoryDiscoverable(t *testing.T) {
	inventory := testInventory()
	inventory.InventoryState = "conflict"
	inventory.Violations = []Violation{{Code: "environment_host_missing", Message: "Host is missing."}}
	inventory.EnvironmentInstances[0].HostID = "missing-host"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(response).Encode(inventory)
	}))
	defer server.Close()
	loaded, err := testClient(t, server.URL).List(context.Background())
	if err != nil {
		t.Fatalf("list conflict inventory: %v", err)
	}
	if loaded.InventoryState != "conflict" ||
		(loaded.EnvironmentInstances[0].HostID != "missing-host" &&
			loaded.EnvironmentInstances[1].HostID != "missing-host") {
		t.Fatalf("inventory = %#v", loaded)
	}
}

func TestClientDoesNotFollowInventoryRedirects(t *testing.T) {
	destinationCalls := 0
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		destinationCalls++
	}))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, destination.URL, http.StatusFound)
	}))
	defer server.Close()
	_, err := testClient(t, server.URL).List(context.Background())
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("error = %v", err)
	}
	if destinationCalls != 0 {
		t.Fatalf("redirect destination calls = %d", destinationCalls)
	}
}

func testClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	client, err := NewClient(Config{
		BaseURL: baseURL, CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(func(context.Context) (string, error) {
			return "machine-token", nil
		}),
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	return client
}

func testInventory() Inventory {
	return Inventory{
		CheckedAt: "2026-08-11T10:00:00Z",
		EnvironmentCatalog: []EnvironmentDefinition{{
			BootstrapStrategy: "ssh", ID: "definition-linux", Kind: "native_linux",
			Name: "Linux", OperatingSystemFamily: "linux", Ownership: "built_in",
			Slug: "linux", SupportedArchitectures: []string{},
		}},
		EnvironmentInstances: []EnvironmentInstance{
			{
				AccessRoutes: []AccessRoute{}, Alias: "zeta", EnvironmentDefinitionID: "definition-linux",
				HostResolution: "not_applicable", Hostd: HostdAvailability{State: "unknown"}, ID: "environment-z",
				Kind: "native_linux", Name: "Zeta", PlatformID: "platform-z", ProviderLifecycleState: "unknown",
				Reference: "platform-z/provider/environment-z", ResourceMode: "dedicated",
				WorkspaceInventory: InventoryAvailability{State: "unavailable"}, Workspaces: []WorkspaceSummary{},
			},
			{
				AccessRoutes: []AccessRoute{}, Alias: "alpha", EnvironmentDefinitionID: "definition-linux",
				HostResolution: "not_applicable", Hostd: HostdAvailability{State: "unknown"}, ID: "environment-a",
				Kind: "native_linux", Name: "Alpha", PlatformID: "platform-a", ProviderLifecycleState: "unknown",
				Reference: "platform-a/provider/environment-a", ResourceMode: "dedicated",
				WorkspaceInventory: InventoryAvailability{State: "unavailable"}, Workspaces: []WorkspaceSummary{},
			},
		},
		Hosts:          []Host{},
		InventoryState: "ready",
		Platforms: []Platform{
			{Alias: "zeta", ID: "platform-z", Kind: "other", Name: "Zeta"},
			{Alias: "alpha", ID: "platform-a", Kind: "local", Name: "Alpha"},
		},
		SchemaVersion: 1,
		Violations:    []Violation{},
	}
}
