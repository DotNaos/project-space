package projectcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientLoadsAuthenticatedProjectCatalog(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/projects/catalog" {
			t.Fatalf("request = %s %s", request.Method, request.URL.String())
		}
		if request.Header.Get("Authorization") != "Bearer machine-token" ||
			request.Header.Get("X-Project-Machine-ID") != "machine-one" {
			t.Fatalf("headers = %#v", request.Header)
		}
		_ = json.NewEncoder(response).Encode(testCatalog())
	}))
	defer server.Close()

	client, err := NewClient(Config{
		BaseURL:         server.URL,
		CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "machine-token", nil },
		),
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	catalog, err := client.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(catalog.Projects) != 2 ||
		catalog.Projects[0].Repository != "DotNaos/design-space" ||
		catalog.Projects[1].LocalCandidates[0].Path != "/projects/project-space" {
		t.Fatalf("catalog = %#v", catalog)
	}
}

func TestClientClassifiesStructuredFailures(t *testing.T) {
	for _, test := range []struct {
		status   int
		sentinel error
	}{
		{status: http.StatusUnauthorized, sentinel: ErrUnauthorized},
		{status: http.StatusForbidden, sentinel: ErrUnauthorized},
		{status: http.StatusServiceUnavailable, sentinel: ErrUnavailable},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(
			response http.ResponseWriter,
			_ *http.Request,
		) {
			response.WriteHeader(test.status)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"error": map[string]string{
					"code":    "catalog_unavailable",
					"message": "Catalog failed.",
				},
			})
		}))
		client := testClient(t, server.URL)
		_, err := client.List(context.Background())
		server.Close()
		if !errors.Is(err, test.sentinel) {
			t.Fatalf("status %d error = %v", test.status, err)
		}
		var failure *APIError
		if !errors.As(err, &failure) || failure.Message != "Catalog failed." {
			t.Fatalf("status %d API error = %#v", test.status, err)
		}
	}
}

func TestClientRejectsMalformedAndOversizedCatalogs(t *testing.T) {
	for _, handler := range []http.HandlerFunc{
		func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write([]byte("{"))
		},
		func(response http.ResponseWriter, _ *http.Request) {
			catalog := testCatalog()
			catalog.SchemaVersion = 2
			_ = json.NewEncoder(response).Encode(catalog)
		},
		func(response http.ResponseWriter, _ *http.Request) {
			catalog := testCatalog()
			catalog.Projects[1].ID = catalog.Projects[0].ID
			_ = json.NewEncoder(response).Encode(catalog)
		},
		func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write([]byte(`{"schemaVersion":1,"padding":"` +
				strings.Repeat("x", int(maximumResponseBytes)) + `"}`))
		},
	} {
		server := httptest.NewServer(handler)
		client := testClient(t, server.URL)
		_, err := client.List(context.Background())
		server.Close()
		if !errors.Is(err, ErrInvalidResponse) {
			t.Fatalf("error = %v", err)
		}
	}
}

func testClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	client, err := NewClient(Config{
		BaseURL:         baseURL,
		CallerMachineID: "machine-one",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "machine-token", nil },
		),
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	return client
}

func testCatalog() Catalog {
	return Catalog{
		Account: Account{Login: "owner"},
		Catalog: CatalogEvidence{
			CacheState: "fresh",
			CheckedAt:  "2026-07-28T00:00:00.000Z",
			Status:     "connected",
		},
		Projects: []Project{
			{
				DisplayName:     "design-space",
				ID:              "github:1",
				LocalCandidates: []LocalCandidate{},
				Repository:      "DotNaos/design-space",
			},
			{
				DisplayName: "project-space",
				ID:          "github:2",
				LocalCandidates: []LocalCandidate{{
					Path:      "/projects/project-space",
					ProjectID: "project-one",
				}},
				Repository: "DotNaos/project-space",
			},
		},
		SchemaVersion: 1,
	}
}
