package workspacesession

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	controlCapability   = "runtime.control.v1"
	mutationCapability  = "runtime.mutation.v1"
	controlCommandLimit = 5 * time.Second
	controlOutputLimit  = 256 * 1024
	controlSummaryLimit = 512
	controlMessageLimit = 48 * 1024
)

var controlIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$`)
var controlDevServerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var controlRevisionPattern = regexp.MustCompile(`^[1-9][0-9]*:[A-Za-z0-9:_-]{8,256}$`)

type controlReceiver struct {
	bootstrap      Bootstrap
	journal        controlJournal
	path           string
	run            controlCommandRunner
	mutations      RuntimeMutationExecutor
	mutationFenced bool
	sessionID      string
}

func addControlRegistration(registration *Registration, receiver *controlReceiver) {
	if receiver == nil {
		return
	}
	commandSequence, eventSequence := receiver.watermarks()
	if hasCapability(receiver.bootstrap.RequestedCapabilities, controlCapability) {
		registration.ReadyCapabilities = append(registration.ReadyCapabilities, controlCapability)
	}
	if hasCapability(receiver.bootstrap.RequestedCapabilities, mutationCapability) {
		registration.ReadyCapabilities = append(registration.ReadyCapabilities, mutationCapability)
	}
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

func newControlReceiver(bootstrap Bootstrap, run controlCommandRunner, mutations ...RuntimeMutationExecutor) (*controlReceiver, error) {
	if !hasCapability(bootstrap.RequestedCapabilities, controlCapability) &&
		!hasCapability(bootstrap.RequestedCapabilities, mutationCapability) {
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
	if len(mutations) > 0 {
		receiver.mutations = mutations[0]
	}
	if err := receiver.verifyWorkspace(context.Background()); err != nil {
		return nil, err
	}
	binding := sha256.Sum256([]byte(strings.Join([]string{
		bootstrap.OwnerUserID, bootstrap.WorkspaceID, bootstrap.EnvironmentID, bootstrap.Generation,
		bootstrap.ManifestDigest, bootstrap.WorktreeOwnerThreadID, canonical,
	}, "\x00")))
	receiver.journal, err = loadControlJournal(receiver.path, hex.EncodeToString(binding[:]))
	if err != nil {
		return nil, err
	}
	receiver.mutationFenced = receiver.journal.MutationFenced
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
			if output, recovered := receiver.recoverInterrupted(ctx, command, record); recovered {
				response := receiver.resultResponse(command, output)
				record.Responses = append(record.Responses, response)
				record.State = "completed"
				receiver.journal.LastEventSequence = *response.EventSequence
			} else {
				response := receiver.errorResponse(command, "uncertain")
				record.Responses = append(record.Responses, response)
				record.State = "uncertain"
				receiver.journal.LastEventSequence = *response.EventSequence
			}
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
	record := receiver.journal.command(command.CommandSequence)
	if record == nil {
		return fmt.Errorf("Workspace Runtime control journal changed")
	}
	if isMutationOperation(command.Operation) {
		evidence, err := receiver.prepareMutationEvidence(ctx, command)
		if err != nil {
			response := receiver.errorResponse(command, "unavailable")
			record.Responses = append(record.Responses, response)
			record.State = "completed"
			receiver.journal.LastEventSequence = *response.EventSequence
			if saveErr := saveControlJournal(receiver.path, receiver.journal); saveErr != nil {
				return saveErr
			}
			return emit(response)
		}
		record.Mutation = evidence
		if err := saveControlJournal(receiver.path, receiver.journal); err != nil {
			return err
		}
	}
	output, executeErr := receiver.execute(ctx, command)
	var response controlResponse
	if executeErr != nil {
		code := "unavailable"
		if isMutationOperation(command.Operation) {
			code = "uncertain"
		}
		response = receiver.errorResponse(command, code)
	} else {
		response = receiver.resultResponse(command, output)
	}
	record = receiver.journal.command(command.CommandSequence)
	if record == nil {
		return fmt.Errorf("Workspace Runtime control journal changed")
	}
	record.Responses = append(record.Responses, response)
	record.State = "completed"
	receiver.journal.LastEventSequence = *response.EventSequence
	if command.Operation == "git.commit" && executeErr == nil {
		receiver.journal.MutationFenced = true
		receiver.mutationFenced = true
	}
	if err := saveControlJournal(receiver.path, receiver.journal); err != nil {
		return err
	}
	return emit(response)
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
	case "git.stage", "git.unstage", "git.commit", "task.start",
		"dev-server.start", "dev-server.publish", "dev-server.stop":
		return receiver.executeMutation(operationCtx, command)
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
	response.Message = "The Workspace Runtime control operation is unavailable."
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
