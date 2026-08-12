package workspacesession

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	controlCapability   = "runtime.control.v1"
	controlCommandLimit = 5 * time.Second
	controlOutputLimit  = 256 * 1024
	controlSummaryLimit = 512
	controlMessageLimit = 48 * 1024
)

var controlIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$`)
var controlDevServerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var controlRevisionPattern = regexp.MustCompile(`^[1-9][0-9]*:[A-Za-z0-9:_-]{8,256}$`)

type controlCommandRunner func(context.Context, string, ...string) ([]byte, error)

type controlCommand struct {
	ActorID                string `json:"actorId"`
	ActorKind              string `json:"actorKind"`
	ActorUserID            string `json:"actorUserId"`
	CommandID              string `json:"commandId"`
	CommandSequence        int64  `json:"commandSequence"`
	EnvironmentID          string `json:"environmentId"`
	Generation             string `json:"generation"`
	Operation              string `json:"operation"`
	OperationID            string `json:"operationId"`
	SchemaVersion          int    `json:"schemaVersion"`
	SessionID              string `json:"sessionId"`
	Staged                 *bool  `json:"staged,omitempty"`
	TargetIdentityRevision string `json:"targetIdentityRevision"`
	Type                   string `json:"type"`
	WorkspaceID            string `json:"workspaceId"`
}

type controlResponse struct {
	ActorID                 string      `json:"actorId"`
	ActorKind               string      `json:"actorKind"`
	ActorUserID             string      `json:"actorUserId"`
	CommandID               string      `json:"commandId"`
	CommandSequence         int64       `json:"commandSequence"`
	EnvironmentID           string      `json:"environmentId"`
	Generation              string      `json:"generation"`
	OperationID             string      `json:"operationId"`
	SchemaVersion           int         `json:"schemaVersion"`
	SessionID               string      `json:"sessionId"`
	TargetIdentityRevision  string      `json:"targetIdentityRevision"`
	WorkspaceID             string      `json:"workspaceId"`
	AcceptedCommandSequence *int64      `json:"acceptedCommandSequence,omitempty"`
	Code                    string      `json:"code,omitempty"`
	EventSequence           *int64      `json:"eventSequence,omitempty"`
	Message                 string      `json:"message,omitempty"`
	Operation               string      `json:"operation,omitempty"`
	Output                  interface{} `json:"output,omitempty"`
	Replayed                *bool       `json:"replayed,omitempty"`
	State                   string      `json:"state,omitempty"`
	Type                    string      `json:"type"`
}

type gitStatusSummary struct {
	Clean      bool `json:"clean"`
	Conflicted int  `json:"conflicted"`
	Staged     int  `json:"staged"`
	Truncated  bool `json:"truncated"`
	Unstaged   int  `json:"unstaged"`
	Untracked  int  `json:"untracked"`
}

type gitDiffSummary struct {
	AddedLines   int  `json:"addedLines"`
	BinaryFiles  int  `json:"binaryFiles"`
	ChangedFiles int  `json:"changedFiles"`
	DeletedLines int  `json:"deletedLines"`
	Staged       bool `json:"staged"`
	Truncated    bool `json:"truncated"`
}

type worktreeSummary struct {
	Current   int  `json:"current"`
	Detached  int  `json:"detached"`
	Locked    int  `json:"locked"`
	Prunable  int  `json:"prunable"`
	Total     int  `json:"total"`
	Truncated bool `json:"truncated"`
}

type devServerSummary struct {
	Failed   int `json:"failed"`
	Ready    int `json:"ready"`
	Starting int `json:"starting"`
	Stopped  int `json:"stopped"`
	Total    int `json:"total"`
}

type controlReceiver struct {
	bootstrap Bootstrap
	journal   controlJournal
	path      string
	run       controlCommandRunner
	sessionID string
}

func addControlRegistration(registration *Registration, receiver *controlReceiver) {
	if receiver == nil {
		return
	}
	commandSequence, eventSequence := receiver.watermarks()
	registration.ReadyCapabilities = append(registration.ReadyCapabilities, controlCapability)
	registration.ResumeAfterControlCommandSequence = &commandSequence
	registration.ResumeAfterControlEventSequence = &eventSequence
}

func bindControl(
	ctx context.Context,
	connection interface {
		Write(context.Context, websocket.MessageType, []byte) error
	},
	accepted serverMessage,
	receiver *controlReceiver,
) error {
	if receiver == nil {
		return nil
	}
	if accepted.SessionID == "" || accepted.AcceptedControlEventSequence == nil {
		return fmt.Errorf("Workspace Runtime control socket binding failed")
	}
	responses, err := receiver.bind(accepted.SessionID, *accepted.AcceptedControlEventSequence)
	if err != nil {
		return err
	}
	for _, response := range responses {
		encoded, err := encodeControlResponse(response)
		if err != nil {
			return err
		}
		if err := connection.Write(ctx, websocket.MessageText, encoded); err != nil {
			return err
		}
	}
	return nil
}

func handleControlFrame(
	ctx context.Context,
	frame inboundFrame,
	receiver *controlReceiver,
	connection interface {
		Write(context.Context, websocket.MessageType, []byte) error
	},
) error {
	if receiver == nil {
		return fmt.Errorf("Workspace Runtime control is unavailable")
	}
	if frame.message.Type == "runtime.control.accepted" {
		if frame.message.AcceptedControlEventSequence == nil {
			return fmt.Errorf("Workspace Runtime control acknowledgement is invalid")
		}
		return receiver.acknowledge(*frame.message.AcceptedControlEventSequence)
	}
	if frame.message.Type != "runtime.control.command" {
		return fmt.Errorf("Workspace Runtime server response is invalid")
	}
	return receiver.handle(ctx, frame.encoded, func(response controlResponse) error {
		encoded, err := encodeControlResponse(response)
		if err != nil {
			return err
		}
		return connection.Write(ctx, websocket.MessageText, encoded)
	})
}

func newControlReceiver(bootstrap Bootstrap, run controlCommandRunner) (*controlReceiver, error) {
	if !hasCapability(bootstrap.RequestedCapabilities, controlCapability) {
		return nil, nil
	}
	if run == nil {
		run = runBoundedControlCommand
	}
	canonical, err := canonicalControlWorkspace(bootstrap.WorkspacePath)
	if err != nil {
		return nil, fmt.Errorf("bind Workspace Runtime control path: %w", err)
	}
	current, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("bind Workspace Runtime current directory: %w", err)
	}
	current, err = canonicalControlWorkspace(current)
	if err != nil || current != canonical {
		return nil, fmt.Errorf("Workspace Runtime control directory changed")
	}
	bootstrap.WorkspacePath = canonical
	receiver := &controlReceiver{
		bootstrap: bootstrap,
		path:      filepath.Join(filepath.Dir(bootstrap.JournalPath), "runtime-control-journal.json"),
		run:       run,
	}
	if err := receiver.verifyWorkspace(context.Background()); err != nil {
		return nil, err
	}
	binding := sha256.Sum256([]byte(strings.Join([]string{
		bootstrap.OwnerUserID, bootstrap.WorkspaceID, bootstrap.EnvironmentID, bootstrap.Generation,
		bootstrap.ManifestDigest, canonical,
	}, "\x00")))
	receiver.journal, err = loadControlJournal(receiver.path, hex.EncodeToString(binding[:]))
	if err != nil {
		return nil, err
	}
	return receiver, nil
}

func (receiver *controlReceiver) watermarks() (int64, int64) {
	if receiver == nil {
		return 0, 0
	}
	return receiver.journal.AcceptedCommandSequence, receiver.journal.LastEventSequence
}

func (receiver *controlReceiver) bind(sessionID string, acceptedEventSequence int64) ([]controlResponse, error) {
	if receiver == nil || !controlIdentifierPattern.MatchString(sessionID) || acceptedEventSequence < 0 ||
		acceptedEventSequence < receiver.journal.AcceptedEventSequence || acceptedEventSequence > receiver.journal.LastEventSequence {
		return nil, fmt.Errorf("Workspace Runtime control socket binding is invalid")
	}
	receiver.sessionID = sessionID
	receiver.journal.AcceptedEventSequence = acceptedEventSequence
	if err := saveControlJournal(receiver.path, receiver.journal); err != nil {
		return nil, err
	}
	result := []controlResponse{}
	for _, record := range receiver.journal.Commands {
		for _, persisted := range record.Responses {
			if persisted.EventSequence == nil || *persisted.EventSequence <= acceptedEventSequence {
				continue
			}
			response := persisted
			response.SessionID = sessionID
			result = append(result, response)
		}
	}
	return result, nil
}

func (receiver *controlReceiver) acknowledge(eventSequence int64) error {
	if receiver == nil || eventSequence < receiver.journal.AcceptedEventSequence ||
		eventSequence > receiver.journal.LastEventSequence {
		return fmt.Errorf("Workspace Runtime control acknowledgement is invalid")
	}
	receiver.journal.AcceptedEventSequence = eventSequence
	return saveControlJournal(receiver.path, receiver.journal)
}

func (receiver *controlReceiver) handle(
	ctx context.Context,
	encoded json.RawMessage,
	emit func(controlResponse) error,
) error {
	command, err := receiver.parseCommand(encoded)
	if err != nil {
		return err
	}
	fingerprint, err := controlFingerprint(command)
	if err != nil {
		return err
	}
	if command.CommandSequence <= receiver.journal.AcceptedCommandSequence {
		record := receiver.journal.command(command.CommandSequence)
		if record == nil || record.Fingerprint != fingerprint {
			return fmt.Errorf("Workspace Runtime control replay changed")
		}
		if len(record.Responses) == 1 {
			response := receiver.errorResponse(command, "uncertain")
			record.Responses = append(record.Responses, response)
			record.State = "uncertain"
			receiver.journal.LastEventSequence = *response.EventSequence
			if err := saveControlJournal(receiver.path, receiver.journal); err != nil {
				return err
			}
		}
		for _, persisted := range record.Responses {
			response := persisted
			response.SessionID = receiver.sessionID
			if response.Type == "runtime.control.command-accepted" {
				replayed := true
				response.Replayed = &replayed
			}
			if err := emit(response); err != nil {
				return err
			}
		}
		return nil
	}
	if command.CommandSequence != receiver.journal.AcceptedCommandSequence+1 {
		return fmt.Errorf("Workspace Runtime control command sequence changed")
	}
	receiver.journal.AcceptedCommandSequence = command.CommandSequence
	accepted := receiver.acceptedResponse(command, false)
	receiver.journal.Commands = append(receiver.journal.Commands, controlCommandRecord{
		Fingerprint: fingerprint, Responses: []controlResponse{accepted},
		Sequence: command.CommandSequence, State: "uncertain",
	})
	receiver.journal.LastEventSequence = *accepted.EventSequence
	if len(receiver.journal.Commands) > maximumControlCommands {
		receiver.journal.Commands = receiver.journal.Commands[len(receiver.journal.Commands)-maximumControlCommands:]
	}
	if err := saveControlJournal(receiver.path, receiver.journal); err != nil {
		return err
	}
	if err := emit(accepted); err != nil {
		return err
	}
	output, executeErr := receiver.execute(ctx, command)
	var response controlResponse
	if executeErr != nil {
		response = receiver.errorResponse(command, "unavailable")
	} else {
		response = receiver.resultResponse(command, output)
	}
	record := receiver.journal.command(command.CommandSequence)
	if record == nil {
		return fmt.Errorf("Workspace Runtime control journal changed")
	}
	record.Responses = append(record.Responses, response)
	record.State = "completed"
	receiver.journal.LastEventSequence = *response.EventSequence
	if err := saveControlJournal(receiver.path, receiver.journal); err != nil {
		return err
	}
	return emit(response)
}

func (receiver *controlReceiver) parseCommand(encoded json.RawMessage) (controlCommand, error) {
	if len(encoded) == 0 || len(encoded) > 64*1024 {
		return controlCommand{}, fmt.Errorf("Workspace Runtime control command is invalid")
	}
	var raw map[string]json.RawMessage
	var command controlCommand
	if json.Unmarshal(encoded, &raw) != nil || json.Unmarshal(encoded, &command) != nil {
		return controlCommand{}, fmt.Errorf("Workspace Runtime control command is invalid")
	}
	baseKeys := []string{
		"actorId", "actorKind", "actorUserId", "commandId", "commandSequence", "environmentId",
		"generation", "operation", "operationId", "schemaVersion", "sessionId",
		"targetIdentityRevision", "type", "workspaceId",
	}
	if command.Operation == "git.diff" {
		baseKeys = append(baseKeys, "staged")
	}
	if !exactJSONKeys(raw, baseKeys) || command.Type != "runtime.control.command" || command.SchemaVersion != SchemaVersion ||
		!controlIdentifierPattern.MatchString(command.ActorID) ||
		!oneOf(command.ActorKind, "agent", "human", "orchestrator", "system") ||
		command.ActorUserID != receiver.bootstrap.OwnerUserID || !safeText(command.ActorUserID, 256) ||
		!controlIdentifierPattern.MatchString(command.CommandID) || command.CommandID != command.OperationID ||
		!controlIdentifierPattern.MatchString(command.OperationID) || command.CommandSequence < 1 ||
		command.EnvironmentID != receiver.bootstrap.EnvironmentID || command.Generation != receiver.bootstrap.Generation ||
		command.WorkspaceID != receiver.bootstrap.WorkspaceID || command.SessionID != receiver.sessionID ||
		!controlRevisionPattern.MatchString(command.TargetIdentityRevision) ||
		!oneOf(command.Operation, "git.status", "git.diff", "worktree.list", "dev-server.inspect") ||
		(command.Operation == "git.diff") != (command.Staged != nil) {
		return controlCommand{}, fmt.Errorf("Workspace Runtime control command is invalid")
	}
	return command, nil
}

func (receiver *controlReceiver) verifyWorkspace(ctx context.Context) error {
	checks := []struct {
		args []string
		want string
	}{
		{[]string{"-C", receiver.bootstrap.WorkspacePath, "rev-parse", "--verify", "HEAD"}, receiver.bootstrap.Commit},
		{[]string{"-C", receiver.bootstrap.WorkspacePath, "branch", "--show-current"}, receiver.bootstrap.Branch},
		{[]string{"-C", receiver.bootstrap.WorkspacePath, "config", "--worktree", "--get", "project.workspaceId"}, receiver.bootstrap.WorkspaceID},
	}
	for _, check := range checks {
		checkCtx, cancel := context.WithTimeout(ctx, controlCommandLimit)
		output, err := receiver.run(checkCtx, "git", check.args...)
		cancel()
		if err != nil || strings.TrimSpace(string(output)) != check.want {
			return fmt.Errorf("Workspace Runtime control identity changed")
		}
	}
	return nil
}

func (receiver *controlReceiver) execute(ctx context.Context, command controlCommand) (interface{}, error) {
	operationCtx, cancel := context.WithTimeout(ctx, controlCommandLimit)
	defer cancel()
	switch command.Operation {
	case "git.status":
		output, err := receiver.runGit(operationCtx,
			"status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames")
		if err != nil {
			return nil, err
		}
		return summarizeGitStatus(output)
	case "git.diff":
		args := []string{"diff"}
		if *command.Staged {
			args = append(args, "--cached")
		}
		args = append(args, "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--")
		output, err := receiver.runGit(operationCtx, args...)
		if err != nil {
			return nil, err
		}
		return summarizeGitDiff(output, *command.Staged)
	case "worktree.list":
		output, err := receiver.runGit(operationCtx, "worktree", "list", "--porcelain", "-z")
		if err != nil {
			return nil, err
		}
		return summarizeWorktrees(output, receiver.bootstrap.WorkspacePath)
	case "dev-server.inspect":
		return receiver.summarizeDevServers()
	default:
		return nil, fmt.Errorf("unsupported Workspace Runtime control operation")
	}
}

func (receiver *controlReceiver) runGit(ctx context.Context, args ...string) ([]byte, error) {
	fixed := []string{
		"--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false",
		"-c", "core.untrackedCache=false", "-c", "color.ui=false",
		"-C", receiver.bootstrap.WorkspacePath,
	}
	return receiver.run(ctx, "git", append(fixed, args...)...)
}

func (receiver *controlReceiver) acceptedResponse(command controlCommand, replayed bool) controlResponse {
	response := receiver.responseBinding(command)
	sequence := receiver.journal.LastEventSequence + 1
	response.AcceptedCommandSequence = &command.CommandSequence
	response.EventSequence = &sequence
	response.Operation = command.Operation
	response.Replayed = &replayed
	response.Type = "runtime.control.command-accepted"
	return response
}

func (receiver *controlReceiver) resultResponse(command controlCommand, output interface{}) controlResponse {
	response := receiver.responseBinding(command)
	sequence := receiver.journal.LastEventSequence + 1
	response.EventSequence = &sequence
	response.Operation = command.Operation
	response.Output = output
	response.State = "completed"
	response.Type = "runtime.control.result"
	return response
}

func (receiver *controlReceiver) errorResponse(command controlCommand, code string) controlResponse {
	response := receiver.responseBinding(command)
	sequence := receiver.journal.LastEventSequence + 1
	response.Code = code
	response.EventSequence = &sequence
	response.Message = "The Workspace Runtime inspection operation is unavailable."
	response.Operation = command.Operation
	response.Type = "runtime.control.error"
	return response
}

func (receiver *controlReceiver) responseBinding(command controlCommand) controlResponse {
	return controlResponse{
		ActorID: command.ActorID, ActorKind: command.ActorKind, ActorUserID: command.ActorUserID,
		CommandID: command.CommandID, CommandSequence: command.CommandSequence,
		EnvironmentID: command.EnvironmentID, Generation: command.Generation,
		OperationID: command.OperationID, SchemaVersion: SchemaVersion, SessionID: receiver.sessionID,
		TargetIdentityRevision: command.TargetIdentityRevision, WorkspaceID: command.WorkspaceID,
	}
}

func controlFingerprint(command controlCommand) (string, error) {
	command.SessionID = ""
	encoded, err := json.Marshal(command)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func exactJSONKeys(value map[string]json.RawMessage, expected []string) bool {
	if len(value) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	return true
}

func exactJSONKeysOptional(value map[string]json.RawMessage, required, optional []string) bool {
	if len(value) < len(required) || len(value) > len(required)+len(optional) {
		return false
	}
	allowed := map[string]bool{}
	for _, key := range append(append([]string{}, required...), optional...) {
		allowed[key] = true
	}
	for _, key := range required {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	for key := range value {
		if !allowed[key] {
			return false
		}
	}
	return true
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func validRequestedCapabilities(values []string) bool {
	if len(values) > 2 {
		return false
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !oneOf(value, "runtime.codex.v1", controlCapability) || seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}

func safeControlURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && oneOf(parsed.Scheme, "http", "https") && parsed.Host != "" &&
		parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func encodeControlResponse(response controlResponse) ([]byte, error) {
	encoded, err := json.Marshal(response)
	if err != nil || len(encoded) > controlMessageLimit {
		return nil, fmt.Errorf("Workspace Runtime control response is invalid")
	}
	return encoded, nil
}
