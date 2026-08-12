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
	pointerPattern = regexp.MustCompile(`^runtime-log:/[A-Za-z0-9._/-]+$`)
)

type Bootstrap struct {
	AppServerSocket          string   `json:"appServerSocket,omitempty"`
	Endpoint                 string   `json:"endpoint"`
	CodexBinary              string   `json:"codexBinary,omitempty"`
	Token                    string   `json:"token"`
	WorkspaceID              string   `json:"workspaceId"`
	EnvironmentID            string   `json:"environmentId"`
	Generation               string   `json:"generation"`
	Branch                   string   `json:"branch"`
	Commit                   string   `json:"commit"`
	ManifestDigest           string   `json:"manifestDigest"`
	RuntimeVersion           string   `json:"runtimeVersion"`
	LogPointer               string   `json:"logPointer,omitempty"`
	ReadyPath                string   `json:"readyPath,omitempty"`
	Capabilities             []string `json:"capabilities"`
	RequestedCapabilities    []string `json:"requestedCapabilities,omitempty"`
	OwnerUserID              string   `json:"ownerUserId,omitempty"`
	WorkspacePath            string   `json:"workspacePath,omitempty"`
	JournalPath              string   `json:"journalPath"`
	StatePath                string   `json:"statePath"`
	ExpiresAt                string   `json:"expiresAt"`
	CodexControllerBinary    string   `json:"codexControllerBinary,omitempty"`
	CodexControllerBootstrap string   `json:"codexControllerBootstrap,omitempty"`
}

type Registration struct {
	Branch                            string   `json:"branch"`
	ReadyCapabilities                 []string `json:"readyCapabilities,omitempty"`
	Commit                            string   `json:"commit"`
	EnvironmentID                     string   `json:"environmentId"`
	Generation                        string   `json:"generation"`
	ManifestDigest                    string   `json:"manifestDigest"`
	ResumeAfterSequence               int64    `json:"resumeAfterSequence"`
	ResumeAfterCodexCommandSequence   *int64   `json:"resumeAfterCodexCommandSequence,omitempty"`
	ResumeAfterCodexEventSequence     *int64   `json:"resumeAfterCodexEventSequence,omitempty"`
	ResumeAfterControlCommandSequence *int64   `json:"resumeAfterControlCommandSequence,omitempty"`
	ResumeAfterControlEventSequence   *int64   `json:"resumeAfterControlEventSequence,omitempty"`
	RuntimeVersion                    string   `json:"runtimeVersion"`
	SchemaVersion                     int      `json:"schemaVersion"`
	Type                              string   `json:"type"`
	WorkspaceID                       string   `json:"workspaceId"`
}

type Event struct {
	EventID       string      `json:"eventId"`
	ObservedAt    string      `json:"observedAt"`
	SchemaVersion int         `json:"schemaVersion"`
	Sequence      int64       `json:"sequence"`
	State         string      `json:"state,omitempty"`
	Type          string      `json:"type"`
	DevServers    interface{} `json:"devServers,omitempty"`
	CPUPercent    *float64    `json:"cpuPercent,omitempty"`
	MemoryBytes   *int64      `json:"memoryBytes,omitempty"`
	Pointer       string      `json:"pointer,omitempty"`
}

type serverMessage struct {
	AcceptedSequence             int64  `json:"acceptedSequence"`
	AcceptedControlEventSequence *int64 `json:"acceptedControlEventSequence,omitempty"`
	HeartbeatIntervalSecond      int    `json:"heartbeatIntervalSeconds"`
	Type                         string `json:"type"`
	SessionID                    string `json:"sessionId"`
}

type inboundFrame struct {
	encoded json.RawMessage
	message serverMessage
	err     error
}

type journal struct {
	Acked  int64   `json:"acked"`
	Events []Event `json:"events"`
}

type runtimeState struct {
	LifecycleState string      `json:"lifecycleState"`
	DevServers     interface{} `json:"devServers"`
}

type Client struct {
	Now        func() time.Time
	Dial       func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error)
	Telemetry  func(context.Context) (float64, int64, error)
	ControlRun controlCommandRunner
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
	if client.Telemetry == nil {
		client.Telemetry = processGroupTelemetry
	}
	controller, err := startCodexController(ctx, bootstrap)
	if err != nil {
		return err
	}
	defer controller.stop()
	control, err := newControlReceiver(bootstrap, client.ControlRun)
	if err != nil {
		return err
	}
	state, err := loadJournal(bootstrap.JournalPath)
	if err != nil {
		return err
	}
	if state.Acked == 0 && len(state.Events) == 0 {
		state.Events = append(state.Events, client.lifecycle(state, "running"))
		if hasCapability(bootstrap.Capabilities, "runtime.log-pointers") && bootstrap.LogPointer != "" {
			state.Events = append(state.Events, client.logPointer(state, bootstrap.LogPointer))
		}
		if err := saveJournal(bootstrap.JournalPath, state); err != nil {
			return err
		}
	}
	backoff := time.Second
	for {
		if client.Now().After(mustTime(bootstrap.ExpiresAt)) {
			return fmt.Errorf("Workspace Runtime credential expired")
		}
		err := client.runConnection(ctx, bootstrap, &state, controller, control)
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

func (client Client) runConnection(ctx context.Context, bootstrap Bootstrap, state *journal, controller *codexController, control *controlReceiver) error {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+bootstrap.Token)
	connection, _, err := client.Dial(ctx, bootstrap.Endpoint, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return err
	}
	defer connection.CloseNow()
	connection.SetReadLimit(64 * 1024)
	readContext, stopReading := context.WithCancel(context.Background())
	defer stopReading()
	inbound := readFrames(readContext, connection)
	registration := Registration{
		Branch: bootstrap.Branch, Commit: bootstrap.Commit, EnvironmentID: bootstrap.EnvironmentID,
		Generation: bootstrap.Generation, ManifestDigest: bootstrap.ManifestDigest,
		ResumeAfterSequence: state.Acked, RuntimeVersion: bootstrap.RuntimeVersion,
		SchemaVersion: SchemaVersion, Type: "runtime.register", WorkspaceID: bootstrap.WorkspaceID,
	}
	if controller != nil {
		commandSequence, eventSequence := controller.watermarks()
		registration.ReadyCapabilities = []string{"runtime.codex.v1"}
		registration.ResumeAfterCodexCommandSequence = &commandSequence
		registration.ResumeAfterCodexEventSequence = &eventSequence
	}
	addControlRegistration(&registration, control)
	if err := writeJSON(ctx, connection, registration); err != nil {
		return err
	}
	accepted, err := readAccepted(ctx, inbound, "runtime.registered", controller, control, connection)
	if err != nil {
		return err
	}
	if accepted.AcceptedSequence < state.Acked {
		return fmt.Errorf("Workspace Runtime server sequence regressed")
	}
	acknowledge(state, accepted.AcceptedSequence)
	if controller != nil {
		_, eventSequence := controller.watermarks()
		if accepted.SessionID == "" || controller.bind(accepted.SessionID, eventSequence) != nil {
			return fmt.Errorf("Workspace Runtime Codex socket binding failed")
		}
	}
	if err := bindControl(ctx, connection, accepted, control); err != nil {
		return err
	}
	if err := saveJournal(bootstrap.JournalPath, *state); err != nil {
		return err
	}
	if err := client.flush(ctx, connection, inbound, bootstrap.JournalPath, state, controller, control); err != nil {
		if ctx.Err() != nil {
			return client.flushGracefulShutdown(bootstrap, connection, inbound, state, controller, control)
		}
		return err
	}
	interval := time.Duration(accepted.HeartbeatIntervalSecond) * time.Second
	if interval <= 0 || interval > time.Minute {
		return fmt.Errorf("Workspace Runtime heartbeat interval is invalid")
	}
	heartbeat := time.NewTicker(interval)
	defer heartbeat.Stop()
	statePoll := time.NewTicker(250 * time.Millisecond)
	defer statePoll.Stop()
	lastState := ""
	lastLifecycle := "running"
	for {
		select {
		case <-ctx.Done():
			return client.flushGracefulShutdown(bootstrap, connection, inbound, state, controller, control)
		case frame, open := <-inbound:
			if !open {
				return fmt.Errorf("Workspace Runtime server connection closed")
			}
			if err := handleInbound(ctx, frame, controller, control, connection); err != nil {
				return err
			}
		case message, open := <-controllerMessages(controller):
			if !open && controller != nil {
				return fmt.Errorf("Workspace Runtime Codex controller stopped")
			}
			if len(message) > 0 {
				var envelope struct {
					Type    string          `json:"type"`
					Message json.RawMessage `json:"message"`
				}
				if json.Unmarshal(message, &envelope) != nil || envelope.Type != "controller.message" || len(envelope.Message) == 0 {
					return fmt.Errorf("Workspace Runtime Codex controller output is invalid")
				}
				if err := connection.Write(ctx, websocket.MessageText, envelope.Message); err != nil {
					return err
				}
			}
		case <-statePoll.C:
			if hasCapability(bootstrap.Capabilities, "runtime.dev-servers") {
				encoded, readErr := readProtected(bootstrap.StatePath, 64*1024)
				if readErr != nil {
					return fmt.Errorf("read Workspace Runtime dev server state: %w", readErr)
				}
				current := string(encoded)
				if current != lastState {
					var observed runtimeState
					if json.Unmarshal(encoded, &observed) != nil || observed.DevServers == nil {
						return fmt.Errorf("decode Workspace Runtime dev server state")
					}
					if observed.LifecycleState != lastLifecycle {
						state.Events = append(state.Events, client.lifecycle(*state, observed.LifecycleState))
						lastLifecycle = observed.LifecycleState
					}
					state.Events = append(state.Events, client.event(*state, "runtime.dev-servers", "", observed.DevServers))
					lastState = current
				}
			}
			if err := saveJournal(bootstrap.JournalPath, *state); err != nil {
				return err
			}
			if err := client.flush(ctx, connection, inbound, bootstrap.JournalPath, state, controller, control); err != nil {
				if ctx.Err() != nil {
					return client.flushGracefulShutdown(bootstrap, connection, inbound, state, controller, control)
				}
				return err
			}
		case <-heartbeat.C:
			if hasCapability(bootstrap.Capabilities, "runtime.telemetry") {
				cpuPercent, memoryBytes, telemetryErr := client.Telemetry(ctx)
				if telemetryErr == nil {
					state.Events = append(state.Events, client.telemetry(*state, cpuPercent, memoryBytes))
				}
			}
			state.Events = append(state.Events, client.event(*state, "runtime.heartbeat", "", nil))
			if err := saveJournal(bootstrap.JournalPath, *state); err != nil {
				return err
			}
			if err := client.flush(ctx, connection, inbound, bootstrap.JournalPath, state, controller, control); err != nil {
				if ctx.Err() != nil {
					return client.flushGracefulShutdown(bootstrap, connection, inbound, state, controller, control)
				}
				return err
			}
		}
	}
}

func (client Client) flushGracefulShutdown(
	bootstrap Bootstrap,
	connection *websocket.Conn,
	inbound <-chan inboundFrame,
	state *journal,
	controller *codexController,
	control *controlReceiver,
) error {
	shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, lifecycle := range []string{"stopping", "stopped"} {
		state.Events = append(state.Events, client.lifecycle(*state, lifecycle))
	}
	if err := saveJournal(bootstrap.JournalPath, *state); err != nil {
		return err
	}
	if err := client.flush(shutdown, connection, inbound, bootstrap.JournalPath, state, controller, control); err == nil {
		return nil
	}
	// A cancellation can close an in-flight websocket read. Reconnect with the
	// same generation credential and let the server's accepted sequence remove
	// any terminal frames it persisted before the connection disappeared.
	header := http.Header{}
	header.Set("Authorization", "Bearer "+bootstrap.Token)
	reconnected, _, err := client.Dial(shutdown, bootstrap.Endpoint, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return err
	}
	defer reconnected.CloseNow()
	reconnected.SetReadLimit(64 * 1024)
	readContext, stopReading := context.WithCancel(context.Background())
	defer stopReading()
	reconnectedInbound := readFrames(readContext, reconnected)
	registration := Registration{
		Branch: bootstrap.Branch, Commit: bootstrap.Commit, EnvironmentID: bootstrap.EnvironmentID,
		Generation: bootstrap.Generation, ManifestDigest: bootstrap.ManifestDigest,
		ResumeAfterSequence: state.Acked, RuntimeVersion: bootstrap.RuntimeVersion,
		SchemaVersion: SchemaVersion, Type: "runtime.register", WorkspaceID: bootstrap.WorkspaceID,
	}
	if controller != nil {
		commandSequence, eventSequence := controller.watermarks()
		registration.ReadyCapabilities = []string{"runtime.codex.v1"}
		registration.ResumeAfterCodexCommandSequence = &commandSequence
		registration.ResumeAfterCodexEventSequence = &eventSequence
	}
	addControlRegistration(&registration, control)
	if err := writeJSON(shutdown, reconnected, registration); err != nil {
		return err
	}
	accepted, err := readAccepted(shutdown, reconnectedInbound, "runtime.registered", controller, control, reconnected)
	if err != nil || accepted.AcceptedSequence < state.Acked {
		return fmt.Errorf("Workspace Runtime graceful reconnect failed")
	}
	if controller != nil {
		_, eventSequence := controller.watermarks()
		if accepted.SessionID == "" || controller.bind(accepted.SessionID, eventSequence) != nil {
			return fmt.Errorf("Workspace Runtime graceful Codex socket binding failed")
		}
	}
	if err := bindControl(shutdown, reconnected, accepted, control); err != nil {
		return err
	}
	acknowledge(state, accepted.AcceptedSequence)
	if err := saveJournal(bootstrap.JournalPath, *state); err != nil {
		return err
	}
	return client.flush(shutdown, reconnected, reconnectedInbound, bootstrap.JournalPath, state, controller, control)
}

func (client Client) flush(ctx context.Context, connection *websocket.Conn, inbound <-chan inboundFrame, path string, state *journal, controller *codexController, control *controlReceiver) error {
	for len(state.Events) > 0 {
		if err := writeJSON(ctx, connection, state.Events[0]); err != nil {
			return fmt.Errorf("write Workspace Runtime %s %s: %w", state.Events[0].Type, state.Events[0].State, err)
		}
		accepted, err := readAccepted(ctx, inbound, "runtime.accepted", controller, control, connection)
		if err != nil {
			// The server persists the terminal event before sending its normal close.
			// A close frame can race the final acknowledgement on the wire, so the
			// explicit normal terminal close is itself safe acceptance evidence.
			if state.Events[0].Type == "runtime.lifecycle" && state.Events[0].State == "stopped" &&
				websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				acknowledge(state, state.Events[0].Sequence)
				return saveJournal(path, *state)
			}
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

func (client Client) telemetry(state journal, cpuPercent float64, memoryBytes int64) Event {
	event := client.event(state, "runtime.telemetry", "", nil)
	event.CPUPercent = &cpuPercent
	event.MemoryBytes = &memoryBytes
	return event
}

func (client Client) logPointer(state journal, pointer string) Event {
	event := client.event(state, "runtime.log-pointer", "", nil)
	event.Pointer = pointer
	return event
}

func (client Client) event(state journal, kind, lifecycle string, devServers interface{}) Event {
	sequence := state.Acked + int64(len(state.Events)) + 1
	return Event{EventID: fmt.Sprintf("runtime-%d-%d", client.Now().UnixNano(), sequence), ObservedAt: client.Now().UTC().Format(time.RFC3339Nano),
		SchemaVersion: SchemaVersion, Sequence: sequence, State: lifecycle, Type: kind, DevServers: devServers}
}

func readAccepted(ctx context.Context, inbound <-chan inboundFrame, expected string, controller *codexController, control *controlReceiver, connection *websocket.Conn) (serverMessage, error) {
	for {
		select {
		case <-ctx.Done():
			return serverMessage{}, ctx.Err()
		case frame, open := <-inbound:
			if !open {
				return serverMessage{}, fmt.Errorf("Workspace Runtime server connection closed")
			}
			if frame.err != nil {
				return serverMessage{}, frame.err
			}
			if frame.message.Type == "runtime.codex.command" {
				if controller == nil || controller.commandMessage(frame.encoded) != nil {
					return serverMessage{}, fmt.Errorf("Workspace Runtime Codex command is unavailable")
				}
				continue
			}
			if strings.HasPrefix(frame.message.Type, "runtime.control.") {
				if err := handleInbound(ctx, frame, controller, control, connection); err != nil {
					return serverMessage{}, err
				}
				continue
			}
			if frame.message.Type != expected || frame.message.AcceptedSequence < 0 {
				return serverMessage{}, fmt.Errorf("Workspace Runtime server response is invalid")
			}
			return frame.message, nil
		}
	}
}

func readFrames(ctx context.Context, connection *websocket.Conn) <-chan inboundFrame {
	frames := make(chan inboundFrame, 1)
	go func() {
		defer close(frames)
		for {
			_, encoded, err := connection.Read(ctx)
			if err != nil {
				sendInboundFrame(ctx, frames, inboundFrame{err: err})
				return
			}
			var message serverMessage
			if json.Unmarshal(encoded, &message) != nil {
				sendInboundFrame(ctx, frames, inboundFrame{err: fmt.Errorf("Workspace Runtime server response is invalid")})
				return
			}
			if !sendInboundFrame(ctx, frames, inboundFrame{encoded: append(json.RawMessage(nil), encoded...), message: message}) {
				return
			}
		}
	}()
	return frames
}

func sendInboundFrame(ctx context.Context, frames chan<- inboundFrame, frame inboundFrame) bool {
	select {
	case frames <- frame:
		return true
	case <-ctx.Done():
		return false
	}
}

func handleInbound(ctx context.Context, frame inboundFrame, controller *codexController, control *controlReceiver, connection *websocket.Conn) error {
	if frame.err != nil {
		return frame.err
	}
	if frame.message.Type == "runtime.codex.command" && controller != nil {
		return controller.commandMessage(frame.encoded)
	}
	return handleControlFrame(ctx, frame, control, connection)
}

func controllerMessages(controller *codexController) <-chan json.RawMessage {
	if controller == nil {
		return nil
	}
	return controller.messages
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
		(value.LogPointer != "" && (!pointerPattern.MatchString(value.LogPointer) ||
			strings.Contains(value.LogPointer, "..") || len(value.LogPointer) > 512)) ||
		!validCapabilities(value.Capabilities) || !validRequestedCapabilities(value.RequestedCapabilities) ||
		!filepath.IsAbs(value.JournalPath) || !filepath.IsAbs(value.StatePath) ||
		filepath.Clean(value.JournalPath) != value.JournalPath || filepath.Clean(value.StatePath) != value.StatePath ||
		filepath.Dir(value.JournalPath) != filepath.Dir(value.StatePath) || value.JournalPath == value.StatePath ||
		expiresAt.IsZero() || !expiresAt.After(now) || expiresAt.After(now.Add(time.Hour)) {
		return fmt.Errorf("Workspace Runtime session bootstrap is invalid")
	}
	if value.ReadyPath != "" && (!validAbsolutePath(value.ReadyPath) || filepath.Dir(value.ReadyPath) != filepath.Dir(value.JournalPath) ||
		value.ReadyPath == value.JournalPath || value.ReadyPath == value.StatePath) {
		return fmt.Errorf("Workspace Runtime session launch bootstrap is invalid")
	}
	controllerRequested := hasCapability(value.RequestedCapabilities, "runtime.codex.v1")
	controlRequested := hasCapability(value.RequestedCapabilities, controlCapability)
	if controlRequested && (!safeText(value.OwnerUserID, 256) || !validAbsolutePath(value.WorkspacePath)) {
		return fmt.Errorf("Workspace Runtime control bootstrap is invalid")
	}
	controllerValuesPresent := value.CodexControllerBinary != "" || value.CodexControllerBootstrap != ""
	if controllerRequested != controllerValuesPresent || controllerValuesPresent &&
		(!validAbsolutePath(value.CodexControllerBinary) || !validAbsolutePath(value.CodexControllerBootstrap)) {
		return fmt.Errorf("Workspace Runtime Codex controller bootstrap is invalid")
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
