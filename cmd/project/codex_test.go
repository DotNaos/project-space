package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/codextask"
)

const codexTestThreadID = "019f6cfb-733e-7ab1-a1ce-1a583f4d9844"

type fakeCodexTaskAPI struct {
	authorize func(context.Context, codextask.AuthorizationRequest) (codextask.AuthorizationResult, error)
	attach    func(context.Context, codextask.AttachRequest) (codextask.AttachResult, error)
	read      func(context.Context, codextask.ReadRequest) (codextask.ReadResult, error)
	send      func(context.Context, codextask.SendRequest) (codextask.SendResult, error)
	start     func(context.Context, codextask.StartRequest) (codextask.StartResult, error)
	stream    func(context.Context, codextask.SubscribeRequest, codextask.EventHandler) error
}

func (fake fakeCodexTaskAPI) Authorize(
	ctx context.Context,
	request codextask.AuthorizationRequest,
) (codextask.AuthorizationResult, error) {
	return fake.authorize(ctx, request)
}

func (fake fakeCodexTaskAPI) Start(ctx context.Context, request codextask.StartRequest) (codextask.StartResult, error) {
	return fake.start(ctx, request)
}

func (fake fakeCodexTaskAPI) Read(ctx context.Context, request codextask.ReadRequest) (codextask.ReadResult, error) {
	return fake.read(ctx, request)
}

func (fake fakeCodexTaskAPI) Send(ctx context.Context, request codextask.SendRequest) (codextask.SendResult, error) {
	return fake.send(ctx, request)
}

func (fake fakeCodexTaskAPI) Stream(ctx context.Context, request codextask.SubscribeRequest, handler codextask.EventHandler) error {
	return fake.stream(ctx, request, handler)
}

func (fake fakeCodexTaskAPI) Attach(ctx context.Context, request codextask.AttachRequest) (codextask.AttachResult, error) {
	return fake.attach(ctx, request)
}

func TestCodexStartHereUsesAuthenticatedCallerWithoutPhysicalSelector(t *testing.T) {
	target := codexTestTarget()
	client := fakeCodexTaskAPI{
		start: func(_ context.Context, request codextask.StartRequest) (codextask.StartResult, error) {
			if request.PhysicalMachineID != "" || request.PhysicalMachineName != "" || request.ConnectorID != "" {
				t.Fatalf("--here selector = %#v", request.Selector)
			}
			if request.OperationID != "test-start-operation" || request.Issue != 262 || !request.DryRun || request.RepositoryID != "DotNaos/project-space" {
				t.Fatalf("request = %#v", request)
			}
			return codextask.StartResult{
				APIVersion: codextask.APIVersion, OperationID: request.OperationID,
				State: codextask.StateReady, Target: target,
			}, nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"start", "--issue", "262", "--here", "--dry-run", "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"state":"ready"`) {
		t.Fatalf("output = %s", output)
	}
}

func TestCodexReadWritesOnlyJSON(t *testing.T) {
	client := fakeCodexTaskAPI{
		read: func(_ context.Context, request codextask.ReadRequest) (codextask.ReadResult, error) {
			if request.PhysicalMachineName != "Remote PC" || request.ConnectorID != "connector-1" || request.Last != 3 {
				t.Fatalf("request = %#v", request)
			}
			return codexTestReadResult(8), nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"read", "--machine", "Remote PC", "--connector", "connector-1", "--thread", codexTestThreadID, "--last", "3"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	decoded := codextask.ReadResult{}
	if json.Unmarshal(output.Bytes(), &decoded) != nil || decoded.Result.Session.ID != codexTestThreadID {
		t.Fatalf("output = %s", output)
	}
}

func TestCodexReadReturnsStructuredBlockedOutcome(t *testing.T) {
	client := fakeCodexTaskAPI{
		read: func(context.Context, codextask.ReadRequest) (codextask.ReadResult, error) {
			return codextask.ReadResult{
				APIVersion: codextask.APIVersion,
				Message:    "The connector is offline.",
				Reason:     codextask.BlockedOffline,
				State:      codextask.StateBlocked,
			}, nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"read", "--machine-id", "physical-1", "--thread", codexTestThreadID})

	if err := command.Execute(); err == nil || !strings.Contains(output.String(), `"reason":"offline"`) {
		t.Fatalf("error = %v output = %s", err, output)
	}
}

func TestCodexSendReadsStdinAndReturnsAcceptedJSON(t *testing.T) {
	client := fakeCodexTaskAPI{
		send: func(_ context.Context, request codextask.SendRequest) (codextask.SendResult, error) {
			if request.Message != "continue from stdin\n" || request.Wait || request.OperationID != "retry-safe-operation" {
				t.Fatalf("request = %#v", request)
			}
			return codexTestAccepted(request.OperationID), nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetIn(strings.NewReader("continue from stdin\n"))
	command.SetOut(output)
	command.SetArgs([]string{"send", "--machine-id", "physical-1", "--thread", codexTestThreadID, "--message", "-", "--no-wait", "--operation-id", "retry-safe-operation"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"state":"accepted"`) {
		t.Fatalf("output = %s", output)
	}
}

func TestCodexSendWaitReturnsStructuredBlockedPreRead(t *testing.T) {
	client := fakeCodexTaskAPI{
		read: func(context.Context, codextask.ReadRequest) (codextask.ReadResult, error) {
			return codextask.ReadResult{
				APIVersion: codextask.APIVersion,
				Message:    "The connector is stale.",
				Reason:     codextask.BlockedStaleConnector,
				State:      codextask.StateBlocked,
			}, nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{
		"send", "--machine-id", "physical-1", "--thread", codexTestThreadID,
		"--message", "continue", "--wait",
	})

	if err := command.Execute(); err == nil || !strings.Contains(output.String(), `"reason":"stale_connector"`) {
		t.Fatalf("error = %v output = %s", err, output)
	}
}

func TestCodexSendWaitOpensStreamBeforeMutationAndReturnsFinalHistory(t *testing.T) {
	var mutex sync.Mutex
	streamOpen := false
	readCount := 0
	client := fakeCodexTaskAPI{
		read: func(_ context.Context, _ codextask.ReadRequest) (codextask.ReadResult, error) {
			mutex.Lock()
			defer mutex.Unlock()
			readCount++
			result := codexTestReadResult(12)
			if readCount == 2 {
				result.Result.Turns = []codextask.ConversationTurn{{ID: "turn-1", Status: "completed", Items: []codextask.ConversationItem{{ID: "answer-1", Kind: "agent_message", Text: "Finished answer"}}}}
			}
			return result, nil
		},
		stream: func(_ context.Context, request codextask.SubscribeRequest, handler codextask.EventHandler) error {
			if request.AfterSequence != 12 || request.OnOpen == nil {
				t.Fatalf("stream request = %#v", request)
			}
			mutex.Lock()
			streamOpen = true
			mutex.Unlock()
			request.OnOpen()
			return handler(codextask.ProgressEvent{
				APIVersion: codextask.APIVersion, Type: "progress",
				Event: &codextask.SessionStreamEvent{EventID: "event-13", Type: "turn-completed", TurnID: "turn-1"},
			})
		},
		send: func(_ context.Context, request codextask.SendRequest) (codextask.SendResult, error) {
			mutex.Lock()
			opened := streamOpen
			mutex.Unlock()
			if !opened {
				t.Fatal("send happened before the stream opened")
			}
			if request.Wait {
				t.Fatal("CLI delegated wait to the server")
			}
			return codexTestAccepted(request.OperationID), nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"send", "--machine-id", "physical-1", "--thread", codexTestThreadID, "--message", "continue", "--wait", "--format", "ndjson"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"type":"progress"`) ||
		!strings.Contains(lines[1], `"state":"completed"`) || !strings.Contains(lines[1], "Finished answer") {
		t.Fatalf("output = %s", output)
	}
}

func TestCodexAttachUsesConfirmedLocalLeaseAndInheritsStreams(t *testing.T) {
	client := fakeCodexTaskAPI{
		attach: func(_ context.Context, request codextask.AttachRequest) (codextask.AttachResult, error) {
			return codextask.AttachResult{
				APIVersion: codextask.APIVersion, ExpiresAt: "2026-07-17T12:00:00Z",
				OperationID: request.OperationID, State: codextask.StateConfirmed,
				Target: codexTestTarget(), ThreadID: request.ThreadID, Transport: "local-unix",
			}, nil
		},
	}
	dependencies := codexTestDependencies(client)
	dependencies.ResolveBinary = func(context.Context, string) (string, error) { return "/working/codex", nil }
	attached := false
	dependencies.AttachLocal = func(_ context.Context, binary, thread string, input io.Reader, output, errorOutput io.Writer) error {
		attached = true
		if binary != "/working/codex" || thread != codexTestThreadID || input == nil || output == nil || errorOutput == nil {
			t.Fatalf("attach = binary %q thread %q", binary, thread)
		}
		return nil
	}
	command := newCodexCommandWithDependencies(dependencies)
	command.SetArgs([]string{"attach", "--machine-id", "physical-1", "--thread", codexTestThreadID})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !attached {
		t.Fatal("local TUI attachment was not launched")
	}
}

func TestCodexAttachUsesHeaderOnlyRemoteLease(t *testing.T) {
	client := fakeCodexTaskAPI{
		attach: func(_ context.Context, request codextask.AttachRequest) (codextask.AttachResult, error) {
			return codextask.AttachResult{
				APIVersion:               codextask.APIVersion,
				EndpointPath:             "/api/codex/tasks/" + request.ThreadID + "/attach/socket",
				ExpiresAt:                "2026-07-17T12:00:00Z",
				OperationID:              request.OperationID,
				RemoteURL:                "wss://projects.example/api/codex/tasks/" + request.ThreadID + "/attach/socket",
				State:                    codextask.StateConfirmed,
				Target:                   codexTestTarget(),
				ThreadID:                 request.ThreadID,
				Token:                    "header-only-token",
				TokenEnvironmentVariable: "PROJECT_CODEX_ATTACH_TOKEN",
				Transport:                "websocket-tunnel",
			}, nil
		},
	}
	dependencies := codexTestDependencies(client)
	dependencies.ResolveBinary = func(context.Context, string) (string, error) { return "/working/codex", nil }
	attached := false
	dependencies.AttachRemote = func(
		_ context.Context,
		binary, remoteURL, token, thread string,
		_ io.Reader,
		_, _ io.Writer,
	) error {
		attached = true
		if binary != "/working/codex" || !strings.HasPrefix(remoteURL, "wss://projects.example/") ||
			token != "header-only-token" || thread != codexTestThreadID {
			t.Fatalf("remote attach = %q %q %q %q", binary, remoteURL, token, thread)
		}
		return nil
	}
	command := newCodexCommandWithDependencies(dependencies)
	command.SetArgs([]string{"attach", "--machine-id", "physical-1", "--thread", codexTestThreadID})

	if err := command.Execute(); err != nil || !attached {
		t.Fatalf("error = %v attached = %v", err, attached)
	}
}

func TestCodexSendWaitJSONIncludesFinalResponse(t *testing.T) {
	readCount := 0
	client := fakeCodexTaskAPI{
		read: func(context.Context, codextask.ReadRequest) (codextask.ReadResult, error) {
			readCount++
			result := codexTestReadResult(2)
			if readCount == 2 {
				result.Result.Turns = []codextask.ConversationTurn{{
					ID: "turn-1", Status: "completed",
					Items: []codextask.ConversationItem{{ID: "answer-1", Kind: "agent_message", Text: "JSON final response"}},
				}}
			}
			return result, nil
		},
		stream: func(_ context.Context, request codextask.SubscribeRequest, handler codextask.EventHandler) error {
			request.OnOpen()
			return handler(codextask.ProgressEvent{
				APIVersion: codextask.APIVersion, Type: "progress",
				Event: &codextask.SessionStreamEvent{EventID: "event-3", Type: "turn-completed", TurnID: "turn-1"},
			})
		},
		send: func(_ context.Context, request codextask.SendRequest) (codextask.SendResult, error) {
			return codexTestAccepted(request.OperationID), nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"send", "--machine-id", "physical-1", "--thread", codexTestThreadID, "--message", "continue", "--wait"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"state":"completed"`) || !strings.Contains(output.String(), "JSON final response") || strings.Contains(output.String(), `"type":"progress"`) {
		t.Fatalf("output = %s", output)
	}
}

func TestCodexSendWaitRetryReturnsCompletionAlreadyPresentBeforeStream(t *testing.T) {
	client := fakeCodexTaskAPI{
		read: func(context.Context, codextask.ReadRequest) (codextask.ReadResult, error) {
			result := codexTestReadResult(8)
			result.Result.Turns = []codextask.ConversationTurn{{
				ID: "turn-1", Status: "completed",
				Items: []codextask.ConversationItem{{
					ID: "answer-1", Kind: "agent_message", Text: "Already finished",
				}},
			}}
			return result, nil
		},
		stream: func(ctx context.Context, request codextask.SubscribeRequest, _ codextask.EventHandler) error {
			request.OnOpen()
			<-ctx.Done()
			return ctx.Err()
		},
		send: func(_ context.Context, request codextask.SendRequest) (codextask.SendResult, error) {
			result := codexTestAccepted(request.OperationID)
			result.TurnID = "turn-1"
			return result, nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{
		"send", "--machine-id", "physical-1", "--thread", codexTestThreadID,
		"--message", "continue", "--wait",
	})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"state":"completed"`) ||
		!strings.Contains(output.String(), "Already finished") {
		t.Fatalf("output = %s", output)
	}
}

func TestTerminalCodexSendResultPreservesInteractionStates(t *testing.T) {
	accepted := codexTestAccepted("retry-safe-operation")
	for eventType, reason := range map[string]codextask.BlockedReason{
		"approval-requested":   codextask.BlockedApprovalRequired,
		"user-input-requested": codextask.BlockedInputRequired,
	} {
		result, terminal := terminalCodexSendResult(accepted, codextask.SessionStreamEvent{
			EventID: "event-1", TurnID: accepted.TurnID, Type: eventType,
		})
		if !terminal || result.State != codextask.StateBlocked || result.Reason != reason {
			t.Errorf("event %q result = %#v terminal = %v", eventType, result, terminal)
		}
	}
	if _, terminal := terminalCodexSendResult(accepted, codextask.SessionStreamEvent{
		EventID: "event-stale", TurnID: "another-turn", Type: "approval-requested",
	}); terminal {
		t.Fatal("approval for another turn was accepted")
	}
}

func TestCodexSendReportsUncertainAfterAcceptedStreamFailure(t *testing.T) {
	client := fakeCodexTaskAPI{
		read: func(context.Context, codextask.ReadRequest) (codextask.ReadResult, error) {
			return codexTestReadResult(1), nil
		},
		stream: func(_ context.Context, request codextask.SubscribeRequest, _ codextask.EventHandler) error {
			request.OnOpen()
			return errors.New("transport disappeared with secret-value")
		},
		send: func(_ context.Context, request codextask.SendRequest) (codextask.SendResult, error) {
			return codexTestAccepted(request.OperationID), nil
		},
	}
	command := newCodexCommandWithDependencies(codexTestDependencies(client))
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"send", "--machine-id", "physical-1", "--thread", codexTestThreadID, "--message", "continue", "--wait"})
	err := command.Execute()
	if err == nil || !strings.Contains(output.String(), `"state":"uncertain"`) || !strings.Contains(output.String(), `"reconcile":"required"`) {
		t.Fatalf("error = %v output = %s", err, output)
	}
}

func TestCodexLoginShowsDeviceCodeAndWaitsForReady(t *testing.T) {
	calls := []codextask.AuthorizationAction{}
	client := fakeCodexTaskAPI{
		authorize: func(
			_ context.Context,
			request codextask.AuthorizationRequest,
		) (codextask.AuthorizationResult, error) {
			calls = append(calls, request.Action)
			result := codextask.AuthorizationResult{
				APIVersion:  codextask.APIVersion,
				Message:     "Codex is authorized and ready.",
				OperationID: request.OperationID,
				State:       codextask.AuthorizationReady,
				Target:      codexTestTarget(),
			}
			if request.Action == codextask.AuthorizationStart {
				result.DeadlineAt = "2099-07-24T00:15:00Z"
				result.Message = "Open the verification page and enter the device code."
				result.State = codextask.AuthorizationPending
				result.UserCode = "ABCD-1234"
				result.VerificationURL = "https://auth.openai.com/codex/device"
			}
			return result, nil
		},
	}
	dependencies := codexTestDependencies(client)
	dependencies.AuthorizationPollAttempts = 2
	dependencies.AuthorizationPollInterval = time.Millisecond
	dependencies.Wait = func(context.Context, time.Duration) error { return nil }
	command := newCodexCommandWithDependencies(dependencies)
	output, diagnostics := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(diagnostics)
	command.SetArgs([]string{"login", "--machine", "Remote PC", "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diagnostics.String(), "ABCD-1234") ||
		strings.Contains(output.String(), "ABCD-1234") ||
		!strings.Contains(output.String(), `"state":"ready"`) {
		t.Fatalf("stdout=%s stderr=%s", output, diagnostics)
	}
	if len(calls) != 2 ||
		calls[0] != codextask.AuthorizationStart ||
		calls[1] != codextask.AuthorizationStatus {
		t.Fatalf("calls = %#v", calls)
	}
}

func codexTestDependencies(client codexTaskAPI) codexCommandDependencies {
	return codexCommandDependencies{
		LoadRuntime: func(context.Context) (codexCommandRuntime, error) {
			return codexCommandRuntime{client: client, localMachineName: "Local Connector"}, nil
		},
		NewOperationID: func(prefix string) (string, error) {
			return map[string]string{
				"codex:start": "test-start-operation", "codex:send": "test-send-operation",
				"codex:attach": "test-attach-operation", "codex:login": "test-login-operation",
			}[prefix], nil
		},
		ResolveRepository: func(context.Context) (string, error) { return "DotNaos/project-space", nil },
	}
}

func codexTestTarget() *codextask.Target {
	target := &codextask.Target{}
	target.PhysicalMachine.ID, target.PhysicalMachine.Name = "physical-1", "Remote PC"
	target.Connector.ID, target.Connector.Name = "connector-1", "WSL"
	return target
}

func codexTestReadResult(cursor uint64) codextask.ReadResult {
	result := codextask.ReadResult{
		APIVersion: codextask.APIVersion,
		Result:     &codextask.SessionReadResult{},
		State:      codextask.StateConfirmed,
		Target:     codexTestTarget(),
	}
	result.Result.OpenedReadOnly = true
	result.Result.Session.ID = codexTestThreadID
	result.Result.Session.MachineID = "connector-1"
	result.Result.StreamCursor = &cursor
	result.Result.Turns = []codextask.ConversationTurn{}
	return result
}

func codexTestAccepted(operationID string) codextask.SendResult {
	return codextask.SendResult{
		APIVersion: codextask.APIVersion, OperationID: operationID, State: codextask.StateAccepted,
		Target: codexTestTarget(), ThreadID: codexTestThreadID, TurnID: "turn-1",
	}
}
