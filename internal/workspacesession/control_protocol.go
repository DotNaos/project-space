package workspacesession

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
)

type controlCommandRunner func(context.Context, string, ...string) ([]byte, error)

type controlCommand struct {
	ActorID                  string `json:"actorId"`
	ActorKind                string `json:"actorKind"`
	ActorUserID              string `json:"actorUserId"`
	CommandID                string `json:"commandId"`
	CommandSequence          int64  `json:"commandSequence"`
	EnvironmentID            string `json:"environmentId"`
	Generation               string `json:"generation"`
	Operation                string `json:"operation"`
	OperationID              string `json:"operationId"`
	SchemaVersion            int    `json:"schemaVersion"`
	SessionID                string `json:"sessionId"`
	Staged                   *bool  `json:"staged,omitempty"`
	Scope                    string `json:"scope,omitempty"`
	ExpectedHead             string `json:"expectedHead,omitempty"`
	Message                  string `json:"message,omitempty"`
	TaskExecutionID          string `json:"taskExecutionId,omitempty"`
	WorkspaceLeaseID         string `json:"workspaceLeaseId,omitempty"`
	ServerID                 string `json:"serverId,omitempty"`
	ExpectedServerGeneration string `json:"expectedServerGeneration,omitempty"`
	TargetIdentityRevision   string `json:"targetIdentityRevision"`
	Type                     string `json:"type"`
	WorkspaceID              string `json:"workspaceId"`
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
	switch command.Operation {
	case "git.stage", "git.unstage":
		baseKeys = append(baseKeys, "scope", "expectedHead")
	case "git.commit":
		baseKeys = append(baseKeys, "message", "expectedHead")
	case "task.start":
		baseKeys = append(baseKeys, "taskExecutionId", "workspaceLeaseId")
	case "dev-server.start":
		baseKeys = append(baseKeys, "serverId")
	case "dev-server.publish", "dev-server.stop":
		baseKeys = append(baseKeys, "serverId", "expectedServerGeneration")
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
		!oneOf(command.Operation, "git.status", "git.diff", "worktree.list", "dev-server.inspect",
			"git.stage", "git.unstage", "git.commit", "task.start",
			"dev-server.start", "dev-server.publish", "dev-server.stop") ||
		(command.Operation == "git.diff") != (command.Staged != nil) {
		return controlCommand{}, fmt.Errorf("Workspace Runtime control command is invalid")
	}
	if isMutationOperation(command.Operation) {
		if !hasCapability(receiver.bootstrap.RequestedCapabilities, mutationCapability) ||
			(command.Scope != "" && command.Scope != "all") ||
			(command.ExpectedHead != "" && !commitPattern.MatchString(command.ExpectedHead)) ||
			!receiver.validMutationInput(command) {
			return controlCommand{}, fmt.Errorf("Workspace Runtime mutation command is invalid")
		}
	} else if !hasCapability(receiver.bootstrap.RequestedCapabilities, controlCapability) {
		return controlCommand{}, fmt.Errorf("Workspace Runtime inspection command is unavailable")
	}
	return command, nil
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
	if len(values) > 3 {
		return false
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !oneOf(value, "runtime.codex.v1", controlCapability, mutationCapability) || seen[value] {
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
