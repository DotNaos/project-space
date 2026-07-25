package machineresources

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientListUsesMachineCredentialHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/machine-resources" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer caller-secret" ||
			request.Header.Get("X-Project-Machine-ID") != "caller-machine" {
			t.Fatalf("unexpected authentication headers: %v", request.Header)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"checkedAt":"2026-07-25T04:00:00Z",
			"machines":[{
				"machineId":"connector-1",
				"machineName":"Macbook Dev",
				"context":{"id":"connector-1","label":"Dev"},
				"state":"partial",
				"sampledAt":"2026-07-25T03:59:59Z",
				"metrics":{
					"cpu":{"state":"available","utilizationPercent":31},
					"memory":{"state":"available","usedBytes":4,"totalBytes":8},
					"disk":{"state":"available","usedBytes":6,"totalBytes":10},
					"gpu":{"state":"unsupported","message":"No supported GPU provider"}
				}
			}]
		}`))
	}))
	defer server.Close()

	client, err := NewClient(Config{
		BaseURL: server.URL, CallerMachineID: "caller-machine", Token: "caller-secret",
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	result, err := client.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(result.Machines) != 1 || result.Machines[0].Context.Label != "Dev" ||
		result.Machines[0].Metrics.GPU.State != MetricUnsupported {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientListAcceptsResultEnvelopeAndRejectsInvalidValues(t *testing.T) {
	for name, body := range map[string]string{
		"envelope": `{"result":{"checkedAt":"2026-07-25T04:00:00Z","machines":[]}}`,
		"invalid": `{"checkedAt":"2026-07-25T04:00:00Z","machines":[{
			"machineId":"connector-1","machineName":"Dev","context":{"id":"dev"},"state":"live",
			"metrics":{
				"cpu":{"state":"available","utilizationPercent":101},
				"memory":{"state":"unsupported"},"disk":{"state":"unsupported"},"gpu":{"state":"unsupported"}
			}
		}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				_, _ = response.Write([]byte(body))
			}))
			defer server.Close()
			client, err := NewClient(Config{
				BaseURL: server.URL, CallerMachineID: "caller-machine", Token: "caller-secret",
			})
			if err != nil {
				t.Fatalf("NewClient: %v", err)
			}
			_, err = client.List(context.Background())
			if name == "invalid" && err == nil {
				t.Fatal("expected invalid response error")
			}
			if name == "envelope" && err != nil {
				t.Fatalf("List: %v", err)
			}
		})
	}
}

func TestNewClientRejectsInsecureRemoteBackend(t *testing.T) {
	if _, err := NewClient(Config{
		BaseURL: "http://example.com", CallerMachineID: "caller-machine", Token: "caller-secret",
	}); err == nil {
		t.Fatal("expected insecure backend to be rejected")
	}
}
