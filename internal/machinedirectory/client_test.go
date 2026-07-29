package machinedirectory

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testMachineID = "11111111-1111-4111-8111-111111111111"

func TestClientAuthenticatesAndEncodesThreadFilters(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Header.Get("Authorization") != "Bearer token" ||
			request.Header.Get("X-Project-Machine-ID") != "caller" {
			t.Fatalf("authentication headers = %#v", request.Header)
		}
		if request.URL.Query().Get("machineId") != testMachineID ||
			request.URL.Query().Get("search") != "roadmap" ||
			request.URL.Query().Get("includeArchived") != "true" ||
			strings.Join(request.URL.Query()["state"], ",") != "active,idle" {
			t.Fatalf("query = %s", request.URL.RawQuery)
		}
		fmt.Fprint(response, `{
		  "checkedAt":"2026-07-28T16:00:00Z",
		  "hosts":[],
		  "partial":false,
		  "schemaVersion":1,
		  "threads":[]
		}`)
	}))
	defer server.Close()
	client := testClient(t, server.URL)
	result, err := client.ListThreads(context.Background(), ThreadFilter{
		IncludeArchived: true,
		MachineID:       testMachineID,
		Search:          "roadmap",
		States:          []string{"active", "idle"},
	})
	if err != nil || result.SchemaVersion != 1 {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
}

func TestClientRejectsUnknownFieldsAndUnsafeSSHTargets(t *testing.T) {
	for name, payload := range map[string]string{
		"unknown field":     `{"checkedAt":"2026-07-28T16:00:00Z","failures":[],"machines":[],"schemaVersion":1,"secret":"no"}`,
		"unsafe SSH target": `{"machine":{"id":"` + testMachineID + `","name":"os-pc"},"schemaVersion":1,"target":"user@host -o ProxyCommand=x"}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(
				response http.ResponseWriter,
				request *http.Request,
			) {
				fmt.Fprint(response, payload)
			}))
			defer server.Close()
			client := testClient(t, server.URL)
			var err error
			if strings.Contains(name, "SSH") {
				_, err = client.ResolveSSH(context.Background(), testMachineID)
			} else {
				_, err = client.ListMachines(context.Background())
			}
			if err != ErrInvalidResponse {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestClientSortsThreadInstantsChronologicallyAcrossOffsets(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		fmt.Fprint(response, `{
		  "checkedAt":"2026-07-28T16:00:00Z",
		  "hosts":[],
		  "partial":false,
		  "schemaVersion":1,
		  "threads":[
		    {
		      "archived":false,
		      "connectorId":"connector-1",
		      "id":"older",
		      "inventoryState":"live",
		      "machine":{"id":"`+testMachineID+`","name":"os-pc"},
		      "state":"idle",
		      "title":"Older",
		      "updatedAt":"2026-07-28T17:00:00+02:00"
		    },
		    {
		      "archived":false,
		      "connectorId":"connector-1",
		      "id":"newer",
		      "inventoryState":"live",
		      "machine":{"id":"`+testMachineID+`","name":"os-pc"},
		      "state":"idle",
		      "title":"Newer",
		      "updatedAt":"2026-07-28T15:30:00Z"
		    }
		  ]
		}`)
	}))
	defer server.Close()
	result, err := testClient(t, server.URL).ListThreads(
		context.Background(), ThreadFilter{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Threads[0].ID != "newer" {
		t.Fatalf("thread order = %#v", result.Threads)
	}
}

func testClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	client, err := NewClient(Config{
		BaseURL:         baseURL,
		CallerMachineID: "caller",
		CredentialProvider: CredentialProviderFunc(
			func(context.Context) (string, error) { return "token", nil },
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}
