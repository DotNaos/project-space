package projectrun

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeReviewRouteAPI struct {
	created    []ReviewRouteCreate
	renewed    []string
	deleted    []string
	mismatched bool
}

func (api *fakeReviewRouteAPI) Create(
	_ context.Context,
	_ string,
	input ReviewRouteCreate,
) (ReviewRoute, error) {
	api.created = append(api.created, input)
	hostname, project, task, err := expectedReviewHostname(input.ProjectSlug, input.TaskID)
	if err != nil {
		return ReviewRoute{}, err
	}
	if api.mismatched {
		hostname = "other-task.review.vpn.os-home.net"
	}
	return ReviewRoute{
		ID: "route-732-2", ProjectSlug: project, TaskID: task, Hostname: hostname,
		BackendIP: input.BackendIP, BackendPort: input.BackendPort, Status: "active",
		ExpiresAt: time.Date(2026, 7, 11, 12, 2, 0, 0, time.UTC),
	}, nil
}

func (api *fakeReviewRouteAPI) Renew(
	_ context.Context,
	_ string,
	routeID string,
	_ string,
	_ int,
) (ReviewRoute, error) {
	api.renewed = append(api.renewed, routeID)
	return ReviewRoute{ID: routeID}, nil
}

func (api *fakeReviewRouteAPI) Delete(
	_ context.Context,
	_ string,
	routeID string,
	_ string,
) error {
	api.deleted = append(api.deleted, routeID)
	return nil
}

func TestManagedServeOwnsExactHTTPSReviewRouteLifecycle(t *testing.T) {
	project := writeTestReviewScripts(t)
	manager, processes, tailnet, prober := newTestManager(t)
	reviewAPI := &fakeReviewRouteAPI{}
	manager.reviewRoutes = reviewAPI
	manager.secrets = func(_ context.Context, sources map[string]string) (map[string]string, error) {
		if sources[reviewRouteAPITokenName] == "" {
			t.Fatal("review route API token reference was not supplied")
		}
		return map[string]string{reviewRouteAPITokenName: strings.Repeat("s", 40)}, nil
	}
	tokenN := 0
	manager.token = func() (string, error) {
		tokenN++
		return fmt.Sprintf("%032d", tokenN), nil
	}
	manager.executable = func() (string, error) { return "/tmp/project-dev", nil }

	started, err := manager.StartWithOptions(context.Background(), project, "dev", StartOptions{
		APIs: APIsModeSimulated, Data: DataModeLocal, ReviewTaskID: "732/2",
	})
	if err != nil {
		t.Fatal(err)
	}
	const hostname = "project-space-732-2.review.vpn.os-home.net"
	if started.ReviewURL == nil || *started.ReviewURL != "https://"+hostname ||
		started.PublicURL == nil || *started.PublicURL != *started.ReviewURL ||
		!reflect.DeepEqual(started.AllowedHosts, []string{"os-macbook.vpn.os-home.net", hostname}) {
		t.Fatalf("review result = %#v", started)
	}
	if len(reviewAPI.created) != 1 || reviewAPI.created[0].BackendIP != "100.80.135.9" ||
		reviewAPI.created[0].BackendPort != 44419 || reviewAPI.created[0].TaskID != "732-2" {
		t.Fatalf("review create = %#v", reviewAPI.created)
	}
	if len(processes.started) != 2 || processes.started[1].Argv[1] != ReviewRouteHeartbeatCommandName ||
		processes.started[1].SecretEnvironment[reviewRouteAPITokenName] == "" {
		t.Fatalf("managed processes = %#v", processes.started)
	}
	if _, leaked := processes.started[0].SecretEnvironment[reviewRouteAPITokenName]; leaked {
		t.Fatal("review route API token reference leaked into the application server")
	}
	serverEnvironment := processes.started[0].Env
	if !containsEnvironment(serverEnvironment, "PROJECT_ALLOWED_HOSTS=os-macbook.vpn.os-home.net,"+hostname) ||
		!containsEnvironment(serverEnvironment, "VITE_PROJECT_SPACE_SECURE_REVIEW_URL=https://"+hostname) {
		t.Fatalf("server environment = %#v", serverEnvironment)
	}
	if len(prober.waits) != 4 || prober.waits[3].Scheme != "https" ||
		prober.waits[3].Host != hostname || prober.waits[3].Port != 443 {
		t.Fatalf("review probes = %#v", prober.waits)
	}

	stopped, err := manager.Stop(context.Background(), project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if stopped.State != StateStopped || len(reviewAPI.deleted) != 1 || reviewAPI.deleted[0] != "route-732-2" ||
		len(processes.stopped) != 2 || len(tailnet.stopped) != 1 {
		t.Fatalf("review cleanup = result=%#v deleted=%#v processes=%#v", stopped, reviewAPI.deleted, processes.stopped)
	}
}

func TestManagedServeDeletesMismatchedReviewRouteEvidence(t *testing.T) {
	project := writeTestReviewScripts(t)
	manager, _, _, _ := newTestManager(t)
	reviewAPI := &fakeReviewRouteAPI{mismatched: true}
	manager.reviewRoutes = reviewAPI
	manager.secrets = func(_ context.Context, _ map[string]string) (map[string]string, error) {
		return map[string]string{reviewRouteAPITokenName: strings.Repeat("s", 40)}, nil
	}
	manager.token = func() (string, error) { return strings.Repeat("l", 40), nil }

	_, err := manager.StartWithOptions(context.Background(), project, "dev", StartOptions{
		APIs: APIsModeSimulated, Data: DataModeLocal, ReviewTaskID: "732/2",
	})
	if err == nil || !strings.Contains(err.Error(), "mismatched route evidence") {
		t.Fatalf("start error = %v", err)
	}
	if !reflect.DeepEqual(reviewAPI.deleted, []string{"route-732-2"}) {
		t.Fatalf("deleted routes = %#v", reviewAPI.deleted)
	}
}

func TestReviewRouteHTTPClientUsesBearerAndTreatsDeleteNotFoundAsClean(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests = append(requests, request.Method+" "+request.URL.Path)
		if request.Header.Get("Authorization") != "Bearer api-secret" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		if request.Method == http.MethodDelete {
			http.Error(response, `{"error":"review route not found"}`, http.StatusNotFound)
			return
		}
		var input ReviewRouteCreate
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte(`{
          "id":"route-one","project_slug":"project-space","task_id":"732-2",
          "hostname":"project-space-732-2.review.vpn.os-home.net",
          "backend_ip":"100.80.135.9","backend_port":44000,"owner":"project-space",
          "status":"active","expires_at":"2026-08-21T19:00:00Z",
          "created_at":"2026-08-21T18:58:00Z","updated_at":"2026-08-21T18:58:00Z"
        }`))
	}))
	defer server.Close()
	api := HTTPReviewRouteAPI{Endpoint: server.URL, Client: server.Client()}
	created, err := api.Create(context.Background(), "api-secret", ReviewRouteCreate{
		ProjectSlug: "project-space", TaskID: "732-2", BackendIP: "100.80.135.9",
		BackendPort: 44000, LeaseSeconds: 120, LeaseToken: strings.Repeat("l", 40),
	})
	if err != nil || created.ID != "route-one" {
		t.Fatalf("create = %#v err=%v", created, err)
	}
	if err := api.Delete(context.Background(), "api-secret", created.ID, strings.Repeat("l", 40)); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(requests, []string{"POST /", "DELETE /route-one"}) {
		t.Fatalf("requests = %#v", requests)
	}
}

func writeTestReviewScripts(t *testing.T) string {
	t.Helper()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".project"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `version: 3
setup:
  - id: dependencies
    command: [true]
commands:
  test:
    command: [true]
servers:
  dev:
    command: [test-server, --host, "{host}", --port, "{port}"]
    reviewRoute:
      projectSlug: project-space
      apiToken: infisical://27956188-6fce-45c8-ae39-4fff09336e65/prod/REVIEW_ROUTE_API_TOKEN
    healthCheck:
      path: /health
      timeoutSeconds: 2
`
	if err := os.WriteFile(filepath.Join(project, scriptsConfigPath), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return project
}
