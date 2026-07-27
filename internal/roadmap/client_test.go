package roadmap

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

const testRepository = "DotNaos/project-space"

func testGraph() Graph {
	return Graph{
		DependencyFreshness: "current",
		Edges: []Edge{{
			From:      NodeReference{Number: 1, Repository: testRepository},
			Satisfied: true,
			To:        NodeReference{Number: 2, Repository: testRepository},
		}},
		GraphRevision: "12345678",
		Nodes: []Node{
			{
				NodeReference: NodeReference{Number: 1, Repository: testRepository},
				State:         NodeDone,
				Title:         "First",
			},
			{
				NodeReference: NodeReference{Number: 2, Repository: testRepository},
				State:         NodeReady,
				Title:         "Second",
			},
		},
		Paths: [][]NodeReference{{
			{Number: 1, Repository: testRepository},
			{Number: 2, Repository: testRepository},
		}},
		Repository: testRepository,
	}
}

func testClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
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
	return client
}

func TestClientReadsGraphWithMachineAuthentication(t *testing.T) {
	client := testClient(t, http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodGet ||
			request.URL.Path != "/api/roadmap" ||
			request.URL.Query().Get("fullName") != testRepository {
			t.Fatalf("request = %s %s", request.Method, request.URL.String())
		}
		if request.Header.Get("Authorization") != "Bearer machine-token" ||
			request.Header.Get("X-Project-Machine-ID") != "machine-one" {
			t.Fatalf("authentication headers = %#v", request.Header)
		}
		_ = json.NewEncoder(response).Encode(testGraph())
	}))
	graph, err := client.Get(context.Background(), testRepository)
	if err != nil {
		t.Fatalf("get graph: %v", err)
	}
	if !reflect.DeepEqual(graph, testGraph()) {
		t.Fatalf("graph = %#v, want %#v", graph, testGraph())
	}
}

func TestClientSendsAddAndRemoveWithCurrentRevision(t *testing.T) {
	methods := []string{}
	client := testClient(t, http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		methods = append(methods, request.Method)
		if request.URL.Path != "/api/roadmap/dependencies" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		var body struct {
			BlockedIssueNumber int `json:"blockedIssueNumber"`
			Blocker            struct {
				FullName    string `json:"fullName"`
				IssueNumber int    `json:"issueNumber"`
			} `json:"blocker"`
			ExpectedGraphRevision string `json:"expectedGraphRevision"`
			FullName              string `json:"fullName"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode mutation: %v", err)
		}
		if body.BlockedIssueNumber != 2 ||
			body.Blocker.FullName != testRepository ||
			body.Blocker.IssueNumber != 1 ||
			body.ExpectedGraphRevision != "12345678" ||
			body.FullName != testRepository {
			t.Fatalf("mutation = %#v", body)
		}
		_ = json.NewEncoder(response).Encode(testGraph())
	}))
	mutation := MutationRequest{
		BlockedIssueNumber:    2,
		BlockerIssueNumber:    1,
		BlockerRepository:     testRepository,
		ExpectedGraphRevision: "12345678",
		Repository:            testRepository,
	}
	if _, err := client.AddDependency(context.Background(), mutation); err != nil {
		t.Fatalf("add dependency: %v", err)
	}
	if _, err := client.RemoveDependency(context.Background(), mutation); err != nil {
		t.Fatalf("remove dependency: %v", err)
	}
	if !reflect.DeepEqual(methods, []string{http.MethodPost, http.MethodDelete}) {
		t.Fatalf("methods = %v", methods)
	}
}

func TestClientPreservesServerConflictMessage(t *testing.T) {
	client := testClient(t, http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		response.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(response).Encode(map[string]any{
			"error": map[string]string{
				"code":    "revision_conflict",
				"message": "Dependencies changed. Review the latest roadmap before editing.",
			},
		})
	}))
	_, err := client.Get(context.Background(), testRepository)
	var failure *APIError
	if !errors.As(err, &failure) ||
		failure.Code != "revision_conflict" ||
		failure.StatusCode != http.StatusConflict {
		t.Fatalf("error = %#v", err)
	}
}

func TestClientClassifiesStructuredServerFailures(t *testing.T) {
	for _, test := range []struct {
		code     string
		status   int
		sentinel error
	}{
		{code: "github_auth_required", status: http.StatusUnauthorized, sentinel: ErrUnauthorized},
		{code: "github_permission_denied", status: http.StatusForbidden, sentinel: ErrUnauthorized},
		{code: "github_rate_limited", status: http.StatusTooManyRequests, sentinel: ErrUnavailable},
		{code: "roadmap_unavailable", status: http.StatusServiceUnavailable, sentinel: ErrUnavailable},
	} {
		client := testClient(t, http.HandlerFunc(func(
			response http.ResponseWriter,
			_ *http.Request,
		) {
			response.WriteHeader(test.status)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"error": map[string]string{
					"code":    test.code,
					"message": "Roadmap request failed.",
				},
			})
		}))
		_, err := client.Get(context.Background(), testRepository)
		if !errors.Is(err, test.sentinel) {
			t.Fatalf("status %d error = %#v, want %v", test.status, err, test.sentinel)
		}
		var failure *APIError
		if !errors.As(err, &failure) || failure.Code != test.code {
			t.Fatalf("status %d API error = %#v", test.status, err)
		}
	}
}

func TestClientRejectsIncompleteOrContradictoryGraphs(t *testing.T) {
	for _, mutate := range []func(*Graph){
		func(graph *Graph) { graph.Repository = "DotNaos/other" },
		func(graph *Graph) { graph.Paths = nil },
		func(graph *Graph) { graph.Edges[0].Satisfied = false },
		func(graph *Graph) { graph.Paths[0][1].Number = 3 },
	} {
		graph := testGraph()
		mutate(&graph)
		client := testClient(t, http.HandlerFunc(func(
			response http.ResponseWriter,
			_ *http.Request,
		) {
			_ = json.NewEncoder(response).Encode(graph)
		}))
		if _, err := client.Get(context.Background(), testRepository); !errors.Is(
			err,
			ErrInvalidResponse,
		) {
			t.Fatalf("invalid graph error = %v", err)
		}
	}
}
