package codextask

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientUsesAWorktreeSizedDefaultStartTimeout(t *testing.T) {
	client := testClient(t, "https://projects.example", Config{})
	if client.httpClient.Timeout != defaultRequestTimeout ||
		client.authorizationHTTPClient.Timeout != defaultAuthorizationTimeout ||
		client.startHTTPClient.Timeout != defaultStartTimeout ||
		client.startHTTPClient.Timeout < 3*time.Minute {
		t.Fatalf(
			"request timeout = %s authorization timeout = %s start timeout = %s",
			client.httpClient.Timeout,
			client.authorizationHTTPClient.Timeout,
			client.startHTTPClient.Timeout,
		)
	}
}

const (
	testCallerMachine = "connector-caller"
	testOperationID   = "operation-test-0001"
	testThreadID      = "019f5a78-3c4c-7082-bb45-5411be7d9b9a"
)

func TestClientStartBindsCallerCredentialSeparatelyFromTarget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/codex/tasks/start" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer caller-secret" ||
			request.Header.Get(callerMachineHeader) != testCallerMachine ||
			request.Header.Get(callerThreadHeader) != testThreadID ||
			request.Header.Get("Idempotency-Key") != testOperationID {
			t.Fatalf("request headers = %#v", request.Header)
		}
		var input StartRequest
		if json.NewDecoder(request.Body).Decode(&input) != nil {
			t.Fatal("invalid request body")
		}
		if input.PhysicalMachineID != "physical-remote" || input.ConnectorID != "connector-remote" {
			t.Fatalf("target = %#v", input.Selector)
		}
		result := StartResult{
			APIVersion: APIVersion, OperationID: testOperationID,
			State: StateConfirmed, Task: testTaskIdentity(),
		}
		writeTestJSON(t, response, result)
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{CallerThreadID: testThreadID})
	result, err := client.Start(context.Background(), StartRequest{
		Selector: Selector{PhysicalMachineID: "physical-remote", ConnectorID: "connector-remote"},
		Issue:    262, OperationID: testOperationID, RepositoryID: "repository-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Task == nil || result.Task.ThreadID != testThreadID {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientStartAcceptsMachineReadinessPreflightBlock(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		writeTestJSON(t, response, StartResult{
			APIVersion:  APIVersion,
			Message:     "The machine is not ready. Run project doctor --machine-id physical-remote.",
			OperationID: testOperationID,
			Reason:      BlockedMachineNotReady,
			State:       StateBlocked,
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{})
	result, err := client.Start(context.Background(), StartRequest{
		Selector:     Selector{PhysicalMachineID: "physical-remote"},
		DryRun:       true,
		Issue:        299,
		OperationID:  testOperationID,
		RepositoryID: "DotNaos/project-space",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.State != StateBlocked || result.Reason != BlockedMachineNotReady ||
		!strings.Contains(result.Message, "project doctor") {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientStartAcceptsCompleteDryRunPlan(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		result := StartResult{
			APIVersion: APIVersion, OperationID: testOperationID,
			State: StateReady, Target: testTarget(), Plan: testStartPlan(),
		}
		result.Target.Environment = &struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{ID: "environment-1", Name: "Environment 1"}
		writeTestJSON(t, response, result)
	}))
	defer server.Close()

	request := StartRequest{
		Selector: Selector{PhysicalMachineID: "physical-remote"},
		DryRun:   true, Issue: 262, OperationID: testOperationID,
		RepositoryID: "DotNaos/project-space",
	}
	result, err := testClient(t, server.URL, Config{}).Start(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Plan == nil || result.Plan.Workspace.ID != "workspace-1" || result.Plan.Operation.State != StateReady {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientStartAcceptsInitiatorBindingAndSharedWorkerSelectorSyntax(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		plan := testStartPlan()
		plan.ReportingTask.Role = "initiator"
		plan.Worker.Model = "provider/gpt-5.6-luna"
		target := testTarget()
		target.Environment = &struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{ID: "environment-1", Name: "Environment 1"}
		writeTestJSON(t, response, StartResult{
			APIVersion: APIVersion, OperationID: testOperationID,
			State: StateReady, Target: target, Plan: plan,
		})
	}))
	defer server.Close()

	result, err := testClient(t, server.URL, Config{}).Start(context.Background(), StartRequest{
		Selector: Selector{PhysicalMachineID: "physical-remote"},
		DryRun:   true, Issue: 262, Model: " provider/gpt-5.6-luna ",
		OperationID: testOperationID, ReasoningEffort: " high ",
		RepositoryID: "DotNaos/project-space",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Plan == nil || result.Plan.ReportingTask.Role != "initiator" ||
		result.Plan.Worker.Model != "provider/gpt-5.6-luna" {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientRejectsConflictingEnvironmentAndPhysicalSelectors(t *testing.T) {
	_, err := testClient(t, "https://projects.example", Config{}).Start(context.Background(), StartRequest{
		Selector: Selector{EnvironmentID: "environment-1", PhysicalMachineID: "physical-remote"},
		DryRun:   true, Issue: 262, OperationID: testOperationID,
	})
	if !errors.Is(err, ErrInvalidInput) && !strings.Contains(err.Error(), "environment") {
		t.Fatalf("error = %v", err)
	}
}

func TestClientReadUsesCanonicalPhysicalAndConnectorSelectors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/codex/tasks/"+testThreadID ||
			request.URL.Query().Get("physicalMachineName") != "Remote PC" ||
			request.URL.Query().Get("connectorId") != "connector-remote" ||
			request.URL.Query().Get("last") != "20" {
			t.Fatalf("request URL = %s", request.URL.String())
		}
		if request.Header.Get("Idempotency-Key") != "" {
			t.Fatal("read request sent an idempotency key")
		}
		writeTestJSON(t, response, testReadResult())
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{})
	result, err := client.Read(context.Background(), ReadRequest{
		Selector: Selector{PhysicalMachineName: "Remote PC", ConnectorID: "connector-remote"},
		Last:     20, ThreadID: testThreadID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Result.OpenedReadOnly || len(result.Result.Turns) != 0 {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientSendAcceptsMultilinePromptAndValidatesTarget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/codex/tasks/"+testThreadID+"/send" ||
			request.Header.Get("Idempotency-Key") != testOperationID {
			t.Fatalf("request = %s headers=%#v", request.URL.Path, request.Header)
		}
		var input SendRequest
		if json.NewDecoder(request.Body).Decode(&input) != nil || input.Message != "First line\nSecond line" {
			t.Fatalf("input = %#v", input)
		}
		writeTestJSON(t, response, SendResult{
			APIVersion: APIVersion, OperationID: testOperationID, State: StateCompleted,
			Target: testTarget(), ThreadID: testThreadID, TurnID: "turn-one",
			Result: testSessionReadResult(),
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{})
	_, err := client.Send(context.Background(), SendRequest{
		ReadRequest: ReadRequest{Selector: Selector{PhysicalMachineID: "physical-remote", ConnectorID: "connector-remote"}, ThreadID: testThreadID},
		Message:     "First line\nSecond line", OperationID: testOperationID, Wait: true,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestClientAttachKeepsShortLivedTokenOutOfJSONAndFormatting(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set(attachTokenHeader, "short-lived-secret")
		writeTestJSON(t, response, AttachResult{
			APIVersion: APIVersion, ExpiresAt: "2026-07-17T12:00:00Z",
			EndpointPath: "/api/codex/tasks/" + testThreadID + "/attach/socket",
			OperationID:  testOperationID,
			State:        StateConfirmed, Target: testTarget(), ThreadID: testThreadID,
			TokenEnvironmentVariable: "PROJECT_CODEX_ATTACH_TOKEN",
			Transport:                "websocket-tunnel",
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{})
	result, err := client.Attach(context.Background(), AttachRequest{
		ReadRequest: ReadRequest{Selector: Selector{PhysicalMachineID: "physical-remote", ConnectorID: "connector-remote"}, ThreadID: testThreadID},
		OperationID: testOperationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Token != "short-lived-secret" {
		t.Fatal("attach token was not returned to the in-memory caller")
	}
	if result.RemoteURL != "ws"+strings.TrimPrefix(server.URL, "http")+
		"/api/codex/tasks/"+testThreadID+"/attach/socket" {
		t.Fatalf("remote URL = %q", result.RemoteURL)
	}
	encoded, _ := json.Marshal(result)
	formatted := result.String() + result.GoString() + string(encoded)
	if strings.Contains(formatted, "short-lived-secret") {
		t.Fatalf("attach token escaped into output: %s", formatted)
	}
}

func TestClientRejectsRedirectOversizeAndSecretBearingErrors(t *testing.T) {
	t.Run("redirect", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			http.Redirect(response, request, "/elsewhere", http.StatusFound)
		}))
		defer server.Close()
		_, err := testClient(t, server.URL, Config{}).Read(context.Background(), testReadRequest())
		if !errors.Is(err, ErrRedirectRejected) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("oversize", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			_, _ = response.Write([]byte(strings.Repeat("x", 65)))
		}))
		defer server.Close()
		client := testClient(t, server.URL, Config{MaximumResponseBytes: 64})
		_, err := client.Read(context.Background(), testReadRequest())
		if !errors.Is(err, ErrResponseTooLarge) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("safe unauthorized", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			response.WriteHeader(http.StatusUnauthorized)
			_, _ = response.Write([]byte(`{"error":{"code":"unauthorized","message":"do-not-print-secret"}}`))
		}))
		defer server.Close()
		_, err := testClient(t, server.URL, Config{}).Read(context.Background(), testReadRequest())
		if !errors.Is(err, ErrUnauthorized) || strings.Contains(err.Error(), "do-not-print-secret") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestNewClientRejectsInsecureRemoteAndMismatchedResponseIdentity(t *testing.T) {
	if _, err := NewClient(Config{
		BaseURL: "http://example.test", CallerMachineID: testCallerMachine,
		CredentialProvider: CredentialProviderFunc(func(context.Context) (string, error) { return "token", nil }),
	}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("insecure URL error = %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		result := testReadResult()
		result.Target.Connector.ID = "wrong-connector"
		writeTestJSON(t, response, result)
	}))
	defer server.Close()
	_, err := testClient(t, server.URL, Config{}).Read(context.Background(), testReadRequest())
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("mismatched identity error = %v", err)
	}
}

func TestClientRejectsInvalidCredentialWithoutLeakingProviderError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("invalid credential reached the server")
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL, CallerMachineID: testCallerMachine,
		CredentialProvider: CredentialProviderFunc(func(context.Context) (string, error) {
			return "secret with spaces", errors.New("provider contained another-secret")
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Read(context.Background(), testReadRequest())
	if !errors.Is(err, ErrUnauthorized) || strings.Contains(err.Error(), "secret") {
		t.Fatalf("error = %v", err)
	}
}

func testClient(t *testing.T, baseURL string, overrides Config) *Client {
	t.Helper()
	overrides.BaseURL = baseURL
	overrides.CallerMachineID = testCallerMachine
	overrides.CredentialProvider = CredentialProviderFunc(func(context.Context) (string, error) {
		return "caller-secret", nil
	})
	client, err := NewClient(overrides)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func testTarget() *Target {
	target := &Target{}
	target.PhysicalMachine.ID, target.PhysicalMachine.Name = "physical-remote", "Remote PC"
	target.Connector.ID, target.Connector.Name = "connector-remote", "WSL stable"
	target.Connector.Generation = 7
	target.Connector.Environment = "wsl"
	return target
}

func testTaskIdentity() *TaskIdentity {
	task := &TaskIdentity{Target: *testTarget(), CanonicalTaskURL: "https://projects.example/codex/task-one", ThreadID: testThreadID}
	task.Issue.Number, task.Issue.URL = 262, "https://github.com/DotNaos/project-space/issues/262"
	task.Repository.ID, task.Repository.NameWithOwner = "repository-1", "DotNaos/project-space"
	task.ReportingTask = &ReportingTask{Role: "project-manager", ThreadID: testThreadID}
	task.Worker = WorkerSelection{Model: DefaultModel, ReasoningEffort: DefaultReasoningEffort}
	task.Worktree.ID, task.Worktree.Branch = "worktree-1", "issue-262"
	return task
}

func testStartPlan() *StartPlan {
	plan := &StartPlan{}
	plan.Base.Branch, plan.Base.Commit = "issue-262", strings.Repeat("a", 40)
	plan.Environment.ID, plan.Environment.Name = "environment-1", "Environment 1"
	plan.Issue.Number, plan.Issue.URL = 262, "https://github.com/DotNaos/project-space/issues/262"
	plan.Operation.ID, plan.Operation.State = testOperationID, StateReady
	plan.Repository.ID, plan.Repository.NameWithOwner = "repository-1", "DotNaos/project-space"
	plan.ReportingTask = ReportingTask{Role: "project-manager", ThreadID: testThreadID}
	plan.Worker = WorkerSelection{Model: DefaultModel, ReasoningEffort: DefaultReasoningEffort}
	plan.Workspace.ID, plan.Workspace.Branch = "workspace-1", "issue-262"
	plan.Workspace.Commit = plan.Base.Commit
	return plan
}

func testReadRequest() ReadRequest {
	return ReadRequest{Selector: Selector{PhysicalMachineID: "physical-remote", ConnectorID: "connector-remote"}, ThreadID: testThreadID}
}

func testReadResult() ReadResult {
	result := ReadResult{
		APIVersion: APIVersion,
		Result:     &SessionReadResult{},
		State:      StateConfirmed,
		Target:     testTarget(),
	}
	result.Result.OpenedReadOnly = true
	result.Result.Session.ID = testThreadID
	result.Result.Session.MachineID = "connector-remote"
	result.Result.Turns = []ConversationTurn{}
	return result
}

func testSessionReadResult() *SessionReadResult {
	result := testReadResult()
	return result.Result
}

func writeTestJSON(t *testing.T, response http.ResponseWriter, value any) {
	t.Helper()
	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(value); err != nil {
		t.Fatal(err)
	}
}
