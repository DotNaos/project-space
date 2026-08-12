package workspacesession

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const SchemaVersion = 1

var (
	tokenPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	uuidPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	commitPattern  = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
	digestPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	versionPattern = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,64}$`)
)

type Bootstrap struct {
	AppServerSocket string   `json:"appServerSocket,omitempty"`
	Endpoint        string   `json:"endpoint"`
	CodexBinary     string   `json:"codexBinary,omitempty"`
	Token           string   `json:"token"`
	WorkspaceID     string   `json:"workspaceId"`
	EnvironmentID   string   `json:"environmentId"`
	Generation      string   `json:"generation"`
	Branch          string   `json:"branch"`
	Commit          string   `json:"commit"`
	ManifestDigest  string   `json:"manifestDigest"`
	RuntimeVersion  string   `json:"runtimeVersion"`
	ReadyPath       string   `json:"readyPath,omitempty"`
	Capabilities    []string `json:"capabilities"`
	JournalPath     string   `json:"journalPath"`
	StatePath       string   `json:"statePath"`
	ExpiresAt       string   `json:"expiresAt"`
}

type Registration struct {
	Branch              string `json:"branch"`
	Commit              string `json:"commit"`
	EnvironmentID       string `json:"environmentId"`
	Generation          string `json:"generation"`
	ManifestDigest      string `json:"manifestDigest"`
	ResumeAfterSequence int64  `json:"resumeAfterSequence"`
	RuntimeVersion      string `json:"runtimeVersion"`
	SchemaVersion       int    `json:"schemaVersion"`
	Type                string `json:"type"`
	WorkspaceID         string `json:"workspaceId"`
}

type Event struct {
	EventID       string      `json:"eventId"`
	ObservedAt    string      `json:"observedAt"`
	SchemaVersion int         `json:"schemaVersion"`
	Sequence      int64       `json:"sequence"`
	State         string      `json:"state,omitempty"`
	Type          string      `json:"type"`
	DevServers    interface{} `json:"devServers,omitempty"`
}

type serverMessage struct {
	AcceptedSequence        int64  `json:"acceptedSequence"`
	HeartbeatIntervalSecond int    `json:"heartbeatIntervalSeconds"`
	Type                    string `json:"type"`
}

type journal struct {
	Acked  int64   `json:"acked"`
	Events []Event `json:"events"`
}

type Client struct {
	Now  func() time.Time
	Dial func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error)
}

func (client Client) Run(ctx context.Context, bootstrap Bootstrap) error {
	if client.Now == nil {
		client.Now = time.Now
	}
	if err := validateBootstrap(bootstrap, client.Now()); err != nil {
		return err
	}
	if client.Dial == nil {
		client.Dial = websocket.Dial
	}
	state, err := loadJournal(bootstrap.JournalPath)
	if err != nil {
		return err
	}
	if state.Acked == 0 && len(state.Events) == 0 {
		state.Events = append(state.Events, client.lifecycle(state, "running"))
		if err := saveJournal(bootstrap.JournalPath, state); err != nil {
			return err
		}
	}
	backoff := time.Second
	for {
		if client.Now().After(mustTime(bootstrap.ExpiresAt)) {
			return fmt.Errorf("Workspace Runtime credential expired")
		}
		err := client.runConnection(ctx, bootstrap, &state)
		if ctx.Err() != nil {
			return err
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if backoff < 10*time.Second {
			backoff *= 2
		}
	}
}

func (client Client) runConnection(ctx context.Context, bootstrap Bootstrap, state *journal) error {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+bootstrap.Token)
	connection, _, err := client.Dial(ctx, bootstrap.Endpoint, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return err
	}
	defer connection.CloseNow()
	connection.SetReadLimit(64 * 1024)
	registration := Registration{
		Branch: bootstrap.Branch, Commit: bootstrap.Commit, EnvironmentID: bootstrap.EnvironmentID,
		Generation: bootstrap.Generation, ManifestDigest: bootstrap.ManifestDigest,
		ResumeAfterSequence: state.Acked, RuntimeVersion: bootstrap.RuntimeVersion,
		SchemaVersion: SchemaVersion, Type: "runtime.register", WorkspaceID: bootstrap.WorkspaceID,
	}
	if err := writeJSON(ctx, connection, registration); err != nil {
		return err
	}
	accepted, err := readAccepted(ctx, connection, "runtime.registered")
	if err != nil {
		return err
	}
	if accepted.AcceptedSequence < state.Acked {
		return fmt.Errorf("Workspace Runtime server sequence regressed")
	}
	acknowledge(state, accepted.AcceptedSequence)
	if err := saveJournal(bootstrap.JournalPath, *state); err != nil {
		return err
	}
	if err := client.flush(ctx, connection, bootstrap.JournalPath, state); err != nil {
		return err
	}
	interval := time.Duration(accepted.HeartbeatIntervalSecond) * time.Second
	if interval <= 0 || interval > time.Minute {
		return fmt.Errorf("Workspace Runtime heartbeat interval is invalid")
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	lastState := ""
	for {
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			for _, lifecycle := range []string{"stopping", "stopped"} {
				state.Events = append(state.Events, client.lifecycle(*state, lifecycle))
			}
			_ = saveJournal(bootstrap.JournalPath, *state)
			return client.flush(shutdown, connection, bootstrap.JournalPath, state)
		case <-ticker.C:
			if hasCapability(bootstrap.Capabilities, "runtime.dev-servers") {
				encoded, readErr := readProtected(bootstrap.StatePath, 64*1024)
				if readErr != nil {
					return fmt.Errorf("read Workspace Runtime dev server state: %w", readErr)
				}
				current := string(encoded)
				if current != lastState {
					var devServers interface{}
					if json.Unmarshal(encoded, &devServers) != nil {
						return fmt.Errorf("decode Workspace Runtime dev server state")
					}
					state.Events = append(state.Events, client.event(*state, "runtime.dev-servers", "", devServers))
					lastState = current
				}
			}
			state.Events = append(state.Events, client.event(*state, "runtime.heartbeat", "", nil))
			if err := saveJournal(bootstrap.JournalPath, *state); err != nil {
				return err
			}
			if err := client.flush(ctx, connection, bootstrap.JournalPath, state); err != nil {
				return err
			}
		}
	}
}

func (client Client) flush(ctx context.Context, connection *websocket.Conn, path string, state *journal) error {
	for len(state.Events) > 0 {
		if err := writeJSON(ctx, connection, state.Events[0]); err != nil {
			return err
		}
		accepted, err := readAccepted(ctx, connection, "runtime.accepted")
		if err != nil {
			return err
		}
		if accepted.AcceptedSequence != state.Events[0].Sequence {
			return fmt.Errorf("Workspace Runtime acknowledgement changed sequence")
		}
		acknowledge(state, accepted.AcceptedSequence)
		if err := saveJournal(path, *state); err != nil {
			return err
		}
	}
	return nil
}

func (client Client) lifecycle(state journal, value string) Event {
	return client.event(state, "runtime.lifecycle", value, nil)
}

func (client Client) event(state journal, kind, lifecycle string, devServers interface{}) Event {
	sequence := state.Acked + int64(len(state.Events)) + 1
	return Event{EventID: fmt.Sprintf("runtime-%d-%d", client.Now().UnixNano(), sequence), ObservedAt: client.Now().UTC().Format(time.RFC3339Nano),
		SchemaVersion: SchemaVersion, Sequence: sequence, State: lifecycle, Type: kind, DevServers: devServers}
}

func readAccepted(ctx context.Context, connection *websocket.Conn, expected string) (serverMessage, error) {
	_, encoded, err := connection.Read(ctx)
	if err != nil {
		return serverMessage{}, err
	}
	var message serverMessage
	if json.Unmarshal(encoded, &message) != nil || message.Type != expected || message.AcceptedSequence < 0 {
		return serverMessage{}, fmt.Errorf("Workspace Runtime server response is invalid")
	}
	return message, nil
}

func writeJSON(ctx context.Context, connection *websocket.Conn, value interface{}) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return connection.Write(ctx, websocket.MessageText, encoded)
}

func acknowledge(state *journal, sequence int64) {
	for len(state.Events) > 0 && state.Events[0].Sequence <= sequence {
		state.Events = state.Events[1:]
	}
	state.Acked = sequence
}

func loadJournal(path string) (journal, error) {
	encoded, err := readProtected(path, 256*1024)
	if errors.Is(err, os.ErrNotExist) {
		return journal{Events: []Event{}}, nil
	}
	if err != nil {
		return journal{}, err
	}
	var state journal
	if json.Unmarshal(encoded, &state) != nil || state.Acked < 0 || len(state.Events) > 256 {
		return journal{}, fmt.Errorf("Workspace Runtime journal is invalid")
	}
	return state, nil
}

func saveJournal(path string, state journal) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(directory); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("Workspace Runtime journal directory is not protected")
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".runtime-session-journal-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(encoded); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func readProtected(path string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > maximum {
		return nil, fmt.Errorf("Workspace Runtime session file is not protected")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, fmt.Errorf("Workspace Runtime session file changed while opening")
	}
	return io.ReadAll(io.LimitReader(file, maximum+1))
}

func validateBootstrap(value Bootstrap, now time.Time) error {
	endpoint, endpointErr := url.Parse(value.Endpoint)
	validEndpoint := endpointErr == nil && endpoint.Host != "" && endpoint.User == nil && endpoint.RawQuery == "" &&
		endpoint.Fragment == "" && endpoint.Path == "/api/workspace-runtimes/socket" &&
		(endpoint.Scheme == "wss" || endpoint.Scheme == "ws" && (strings.HasPrefix(endpoint.Host, "127.0.0.1:") || strings.HasPrefix(endpoint.Host, "localhost:")))
	expiresAt := mustTime(value.ExpiresAt)
	if value.Endpoint == "" || value.Token == "" || value.WorkspaceID == "" || value.EnvironmentID == "" ||
		value.Generation == "" || value.Commit == "" || value.ManifestDigest == "" || value.ExpiresAt == "" ||
		!validEndpoint || !tokenPattern.MatchString(value.Token) || !uuidPattern.MatchString(value.WorkspaceID) ||
		!uuidPattern.MatchString(value.EnvironmentID) || !uuidPattern.MatchString(value.Generation) ||
		!commitPattern.MatchString(value.Commit) || !digestPattern.MatchString(value.ManifestDigest) ||
		!safeText(value.Branch, 256) || !versionPattern.MatchString(value.RuntimeVersion) ||
		!validCapabilities(value.Capabilities) || !filepath.IsAbs(value.JournalPath) || !filepath.IsAbs(value.StatePath) ||
		filepath.Clean(value.JournalPath) != value.JournalPath || filepath.Clean(value.StatePath) != value.StatePath ||
		filepath.Dir(value.JournalPath) != filepath.Dir(value.StatePath) || value.JournalPath == value.StatePath ||
		expiresAt.IsZero() || !expiresAt.After(now) || expiresAt.After(now.Add(time.Hour)) {
		return fmt.Errorf("Workspace Runtime session bootstrap is invalid")
	}
	launchValuesPresent := value.CodexBinary != "" || value.AppServerSocket != "" || value.ReadyPath != ""
	if launchValuesPresent && (!validAbsolutePath(value.CodexBinary) || !validAbsolutePath(value.AppServerSocket) ||
		!validAbsolutePath(value.ReadyPath) || filepath.Dir(value.ReadyPath) != filepath.Dir(value.JournalPath) ||
		value.ReadyPath == value.JournalPath || value.ReadyPath == value.StatePath) {
		return fmt.Errorf("Workspace Runtime session launch bootstrap is invalid")
	}
	return nil
}

// ValidateBootstrap checks the complete credential and optional runtime-launch
// binding before any process or network operation begins.
func ValidateBootstrap(value Bootstrap, now time.Time) error {
	return validateBootstrap(value, now)
}

func validAbsolutePath(value string) bool {
	return value != "" && filepath.IsAbs(value) && filepath.Clean(value) == value
}

func safeText(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if character < 32 || character == 127 {
			return false
		}
	}
	return true
}

func validCapabilities(values []string) bool {
	allowed := map[string]bool{
		"runtime.lifecycle": true, "runtime.heartbeat": true, "runtime.dev-servers": true,
		"runtime.telemetry": true, "runtime.log-pointers": true,
	}
	if len(values) == 0 || len(values) > len(allowed) {
		return false
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !allowed[value] || seen[value] {
			return false
		}
		seen[value] = true
	}
	return seen["runtime.lifecycle"] && seen["runtime.heartbeat"]
}

func hasCapability(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func mustTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339, value)
	return parsed
}
