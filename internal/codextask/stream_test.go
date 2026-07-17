package codextask

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientStreamResumesNumericCursorAndDeliversTerminalResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/codex/tasks/"+testThreadID+"/stream" ||
			request.Header.Get("Last-Event-ID") != "6" ||
			request.Header.Get(callerMachineHeader) != testCallerMachine ||
			request.URL.Query().Get("physicalMachineId") != "physical-remote" {
			t.Fatalf("stream request = %s headers=%#v", request.URL.String(), request.Header)
		}
		response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		response.WriteHeader(http.StatusOK)
		progress := ProgressEvent{APIVersion: APIVersion, Type: "progress"}
		progress.Event = &SessionStreamEvent{EventID: "event-one", Type: "agent-message-delta", Delta: "Safe progress"}
		result := ProgressEvent{
			Result: &SendResult{
				APIVersion: APIVersion, OperationID: testOperationID, State: StateCompleted,
				Target: testTarget(), ThreadID: testThreadID, TurnID: "turn-one", Result: testSessionReadResult(),
			},
			Type: "result",
		}
		writeSSETestEvent(t, response, 7, progress)
		writeSSETestEvent(t, response, 8, result)
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{})
	var events []ProgressEvent
	opened := false
	err := client.Stream(context.Background(), SubscribeRequest{
		ReadRequest: testReadRequest(), AfterSequence: 6,
		OnOpen: func() { opened = true },
	}, func(event ProgressEvent) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !opened || len(events) != 2 || events[0].Sequence == nil || *events[0].Sequence != 7 ||
		events[1].Result == nil || events[1].Result.State != StateCompleted {
		t.Fatalf("events = %#v", events)
	}
	if !strings.Contains(string(events[0].Event.Raw), `"delta":"Safe progress"`) {
		t.Fatalf("raw event was not retained: %s", events[0].Event.Raw)
	}
}

func TestSSEParserRejectsOpaqueRegressingAndMismatchedCursors(t *testing.T) {
	progress := `{"apiVersion":1,"event":{"eventId":"event-one","type":"session-status","status":"active"},"type":"progress"}`
	tests := []struct {
		name string
		body string
	}{
		{name: "opaque", body: "id: event-seven\nevent: progress\ndata: " + progress + "\n\n"},
		{name: "regressing", body: "id: 6\nevent: progress\ndata: " + progress + "\n\n"},
		{name: "mismatch", body: "id: 7\nevent: progress\ndata: {\"apiVersion\":1,\"event\":{\"eventId\":\"event-one\",\"type\":\"session-status\"},\"sequence\":8,\"type\":\"progress\"}\n\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := readSSE(context.Background(), strings.NewReader(test.body), 6, func(ProgressEvent) error { return nil })
			if !errors.Is(err, ErrInvalidResponse) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestSSEParserWrapsRawServerProgressEvent(t *testing.T) {
	body := `id: 9
event: progress
data: {"eventId":"event-nine","turnId":"turn-one","type":"turn-completed"}

`
	var received ProgressEvent
	err := readSSE(context.Background(), strings.NewReader(body), 8, func(event ProgressEvent) error {
		received = event
		return nil
	})
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("error = %v", err)
	}
	if received.Type != "progress" || received.APIVersion != APIVersion || received.Event == nil ||
		received.Event.Type != "turn-completed" || received.Sequence == nil || *received.Sequence != 9 {
		t.Fatalf("event = %#v", received)
	}
}

func TestSSEParserRejectsOversizedEvent(t *testing.T) {
	body := "id: 1\ndata: " + strings.Repeat("x", maximumSSEEventBytes) + "\n\n"
	err := readSSE(context.Background(), strings.NewReader(body), 0, func(ProgressEvent) error { return nil })
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("error = %v", err)
	}
}

func TestSSEParserPropagatesHandlerError(t *testing.T) {
	wanted := errors.New("stop output")
	body := `id: 1
event: progress
data: {"apiVersion":1,"event":{"eventId":"event-one","type":"session-status","status":"active"},"type":"progress"}

`
	err := readSSE(context.Background(), strings.NewReader(body), 0, func(ProgressEvent) error { return wanted })
	if !errors.Is(err, wanted) {
		t.Fatalf("error = %v", err)
	}
}

func writeSSETestEvent(t *testing.T, response http.ResponseWriter, sequence uint64, event ProgressEvent) {
	t.Helper()
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintf(response, "id: %d\nevent: %s\ndata: %s\n\n", sequence, event.Type, body); err != nil {
		t.Fatal(err)
	}
}
