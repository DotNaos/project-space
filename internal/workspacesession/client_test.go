package workspacesession

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestClientRegistersJournalsHeartbeatsAndFlushesGracefulStop(t *testing.T) {
	var mu sync.Mutex
	var events []Event
	registered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+strings.Repeat("A", 43) {
			t.Error("missing exact bearer credential")
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		_, encoded, err := connection.Read(request.Context())
		if err != nil {
			return
		}
		var registration Registration
		if json.Unmarshal(encoded, &registration) != nil || registration.ResumeAfterSequence != 0 {
			t.Error("invalid registration")
			return
		}
		_ = writeJSON(request.Context(), connection, serverMessage{AcceptedSequence: 0, HeartbeatIntervalSecond: 1, Type: "runtime.registered"})
		close(registered)
		for {
			_, encoded, readErr := connection.Read(request.Context())
			if readErr != nil {
				return
			}
			var event Event
			if json.Unmarshal(encoded, &event) != nil {
				t.Error("invalid event")
				return
			}
			mu.Lock()
			events = append(events, event)
			mu.Unlock()
			_ = writeJSON(request.Context(), connection, serverMessage{AcceptedSequence: event.Sequence, Type: "runtime.accepted"})
			if event.State == "stopped" {
				return
			}
		}
	}))
	defer server.Close()

	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	bootstrap := Bootstrap{
		Endpoint: strings.Replace(server.URL, "http://", "ws://", 1) + "/api/workspace-runtimes/socket", Token: strings.Repeat("A", 43),
		WorkspaceID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", EnvironmentID: "11111111-1111-4111-8111-111111111111",
		Generation: "22222222-2222-4222-8222-222222222222", Branch: "issue-625", Commit: strings.Repeat("a", 40),
		ManifestDigest: strings.Repeat("b", 64), RuntimeVersion: "0.4.66",
		Capabilities: []string{"runtime.lifecycle", "runtime.heartbeat", "runtime.dev-servers"},
		JournalPath:  filepath.Join(directory, "journal.json"), StatePath: filepath.Join(directory, "state.json"),
		ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	}
	if err := saveJournal(bootstrap.JournalPath, journal{}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bootstrap.StatePath, []byte(`[{"name":"web","port":3000,"state":"ready","url":"http://127.0.0.1:3000/"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- (Client{}).Run(ctx, bootstrap) }()
	<-registered
	deadline := time.Now().Add(4 * time.Second)
	for {
		mu.Lock()
		hasRunning := len(events) > 0 && events[0].State == "running"
		hasDevServers := false
		hasHeartbeat := false
		for _, event := range events {
			hasDevServers = hasDevServers || event.Type == "runtime.dev-servers"
			hasHeartbeat = hasHeartbeat || event.Type == "runtime.heartbeat"
		}
		mu.Unlock()
		if hasRunning && hasDevServers && hasHeartbeat || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(events) < 5 || events[0].State != "running" || events[len(events)-2].State != "stopping" || events[len(events)-1].State != "stopped" {
		t.Fatalf("lifecycle events = %#v", events)
	}
	loaded, err := loadJournal(bootstrap.JournalPath)
	if err != nil || len(loaded.Events) != 0 || loaded.Acked != events[len(events)-1].Sequence {
		t.Fatalf("journal = %#v, error=%v", loaded, err)
	}
}

func TestClientRejectsUnboundOrOverprivilegedBootstrapBeforeDial(t *testing.T) {
	directory := t.TempDir()
	now := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	base := Bootstrap{
		Endpoint: "wss://projects.os-home.net/api/workspace-runtimes/socket", Token: strings.Repeat("A", 43),
		WorkspaceID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", EnvironmentID: "11111111-1111-4111-8111-111111111111",
		Generation: "22222222-2222-4222-8222-222222222222", Branch: "issue-625", Commit: strings.Repeat("a", 40),
		ManifestDigest: strings.Repeat("b", 64), RuntimeVersion: "0.5.0-test",
		Capabilities: []string{"runtime.lifecycle", "runtime.heartbeat"},
		JournalPath:  filepath.Join(directory, "journal.json"), StatePath: filepath.Join(directory, "state.json"),
		ExpiresAt: now.Add(30 * time.Minute).Format(time.RFC3339),
	}
	cases := []Bootstrap{
		func() Bootstrap { value := base; value.Endpoint += "?token=secret"; return value }(),
		func() Bootstrap { value := base; value.Token = "short"; return value }(),
		func() Bootstrap { value := base; value.WorkspaceID = "other"; return value }(),
		func() Bootstrap { value := base; value.Branch = "bad\nbranch"; return value }(),
		func() Bootstrap {
			value := base
			value.Capabilities = []string{"runtime.lifecycle", "runtime.shell"}
			return value
		}(),
		func() Bootstrap { value := base; value.Capabilities = []string{"runtime.lifecycle"}; return value }(),
		func() Bootstrap {
			value := base
			value.StatePath = filepath.Join(t.TempDir(), "state.json")
			return value
		}(),
		func() Bootstrap {
			value := base
			value.ExpiresAt = now.Add(2 * time.Hour).Format(time.RFC3339)
			return value
		}(),
	}
	for _, bootstrap := range cases {
		dialed := false
		client := Client{
			Now: func() time.Time { return now },
			Dial: func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
				dialed = true
				return nil, nil, context.Canceled
			},
		}
		if err := client.Run(context.Background(), bootstrap); err == nil || dialed {
			t.Fatalf("invalid bootstrap reached network: %#v error=%v dialed=%v", bootstrap, err, dialed)
		}
	}
}
