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
			request.Header.Get("X-Project-Machine-ID") != "machine-one" ||
			request.Header.Get("Accept") != inventoryV3MediaType {
			t.Fatalf("headers = %#v", request.Header)
		}
		_ = json.NewEncoder(response).Encode(testInventoryV3())
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

func TestClientAcceptsSafeVersionTwoRoutes(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			response.WriteHeader(http.StatusNotAcceptable)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"error": map[string]string{"code": "unsupported_inventory_version", "message": "Unsupported."},
			})
			return
		}
		_ = json.NewEncoder(response).Encode(testInventoryV2())
	}))
	defer server.Close()
	inventory, err := testClient(t, server.URL).List(context.Background())
	if err != nil {
		t.Fatalf("list v2: %v", err)
	}
	readyRoutes := 0
	for _, instance := range inventory.EnvironmentInstances {
		for _, route := range instance.AccessRoutes {
			if route.State == "ready" {
				readyRoutes++
			}
		}
	}
	if requests != 2 || inventory.SchemaVersion != 2 || len(inventory.PrivateNetworks) != 1 || readyRoutes != 1 {
		t.Fatalf("inventory = %#v", inventory)
	}
}

func TestClientAcceptsVersionThreeHostdTelemetry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Accept") != inventoryV3MediaType {
			t.Fatalf("accept = %q", request.Header.Get("Accept"))
		}
		_ = json.NewEncoder(response).Encode(testInventoryV3())
	}))
	defer server.Close()
	inventory, err := testClient(t, server.URL).List(context.Background())
	if err != nil {
		t.Fatalf("list v3: %v", err)
	}
	var observed *EnvironmentInstance
	for index := range inventory.EnvironmentInstances {
		if inventory.EnvironmentInstances[index].Hostd.State == "available" {
			observed = &inventory.EnvironmentInstances[index]
		}
	}
	if inventory.SchemaVersion != 3 || observed == nil || observed.Hostd.HostdVersion != "0.1.0" ||
		observed.Resources == nil || observed.Resources.Source != "hostd" {
		t.Fatalf("inventory = %#v", inventory)
	}
}

func TestClientAcceptsVersionThreePartialHostdTelemetry(t *testing.T) {
	inventory := testInventoryV3()
	instance := &inventory.EnvironmentInstances[0]
	instance.Hostd.Health = "degraded"
	instance.Hostd.PartialMetrics = []string{"cpu", "memory", "storage", "gpu"}
	instance.Resources.CPUUsedPercent = nil
	instance.Resources.MemoryAvailableBytes = nil
	instance.Resources.StorageAvailableBytes = nil
	instance.Resources.GPU = nil
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(response).Encode(inventory)
	}))
	defer server.Close()
	if _, err := testClient(t, server.URL).List(context.Background()); err != nil {
		t.Fatalf("list partial v3: %v", err)
	}
}

func TestInventoryJSONPreservesVersionedRouteShape(t *testing.T) {
	v1, err := json.Marshal(testInventory())
	if err != nil {
		t.Fatalf("marshal v1: %v", err)
	}
	if strings.Contains(string(v1), "privateNetworks") {
		t.Fatalf("v1 contains v2 field: %s", v1)
	}
	v2 := testInventoryV2()
	v2.PrivateNetworks = []PrivateNetwork{}
	v2.EnvironmentInstances[0].AccessRoutes[0].Priority = 0
	encoded, err := json.Marshal(v2)
	if err != nil {
		t.Fatalf("marshal v2: %v", err)
	}
	text := string(encoded)
	if !strings.Contains(text, `"privateNetworks":[]`) || !strings.Contains(text, `"priority":0`) ||
		strings.Contains(text, `"connectorStatus":""`) {
		t.Fatalf("invalid v2 shape: %s", text)
	}
}

func TestClientRejectsMalformedUnknownOversizedAndWrongVersionResponses(t *testing.T) {
	handlers := []http.HandlerFunc{
		func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write([]byte("{")) },
		func(response http.ResponseWriter, _ *http.Request) {
			inventory := testInventory()
			inventory.SchemaVersion = 4
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
			_, _ = response.Write([]byte(`{"schemaVersion":2,"privateNetworks":[],"environmentInstances":[{"accessRoutes":[{"type":"ssh_private_network","privateAddress":"100.64.0.10"}]}]}`))
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

func testInventoryV2() Inventory {
	inventory := testInventory()
	inventory.SchemaVersion = 2
	inventory.PrivateNetworks = []PrivateNetwork{{
		ApprovalState: "approved", ID: "network-one", LastVerifiedAt: "2026-08-11T10:00:00Z",
		Name: "Private tailnet", ProviderKind: "tailscale", State: "available",
	}}
	inventory.EnvironmentInstances[0].AccessRoutes = []AccessRoute{{
		Capabilities: []string{"project_cli"}, ID: "route-one",
		LastVerifiedAt: "2026-08-11T10:00:00Z", Priority: 100,
		ProviderKind: "tailscale", State: "ready", Type: "ssh_private_network",
	}}
	return inventory
}

func testInventoryV3() Inventory {
	inventory := testInventoryV2()
	inventory.SchemaVersion = 3
	used := 12.5
	protocol := 1
	inventory.EnvironmentInstances[0].Hostd = HostdAvailability{
		Health: "healthy", HostdVersion: "0.1.0", LastSeenAt: "2026-08-11T10:00:00Z",
		ObservedAt: "2026-08-11T10:00:00Z", PartialMetrics: []string{},
		ProtocolVersion: &protocol, State: "available",
	}
	inventory.EnvironmentInstances[0].Resources = &ResourceSummary{
		Architecture: "arm64", CPUCores: 10, CPUUsedPercent: &used,
		MemoryAvailableBytes: numberPointer(16 << 30), MemoryTotalBytes: 32 << 30,
		OperatingSystem: "macOS", ReportedAt: "2026-08-11T10:00:00Z", Source: "hostd",
		StorageAvailableBytes: numberPointer(500 << 30), StorageTotalBytes: 1 << 40,
	}
	return inventory
}

func numberPointer(value float64) *float64 { return &value }
