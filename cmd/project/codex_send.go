package main

import (
	"context"
	"errors"

	"github.com/DotNaos/project-space/internal/codextask"
	"github.com/spf13/cobra"
)

type codexStreamUpdate struct {
	event codextask.ProgressEvent
	err   error
}

func sendCodexAndWait(command *cobra.Command, client codexTaskAPI, request codextask.SendRequest, format string) error {
	read, err := client.Read(command.Context(), request.ReadRequest)
	if err != nil {
		return err
	}
	after := uint64(0)
	if read.Result == nil {
		return writeCodexReadBlocked(command, read, request.OperationID, format)
	}
	if read.Result.StreamCursor != nil {
		after = *read.Result.StreamCursor
	}

	streamContext, cancelStream := context.WithCancel(command.Context())
	defer cancelStream()
	ready := make(chan struct{})
	updates := make(chan codexStreamUpdate, 64)
	go func() {
		err := client.Stream(streamContext, codextask.SubscribeRequest{
			ReadRequest: request.ReadRequest, AfterSequence: after,
			OnOpen: func() { close(ready) },
		}, func(progress codextask.ProgressEvent) error {
			select {
			case updates <- codexStreamUpdate{event: progress}:
				return nil
			case <-streamContext.Done():
				return streamContext.Err()
			}
		})
		select {
		case updates <- codexStreamUpdate{err: err}:
		case <-streamContext.Done():
		}
	}()

	var firstUpdate *codexStreamUpdate
	select {
	case <-ready:
	case update := <-updates:
		select {
		case <-ready:
			firstUpdate = &update
		default:
			if update.err == nil {
				return &codexOutcomeError{message: "Codex progress stream ended before it opened"}
			}
			return update.err
		}
	case <-command.Context().Done():
		return command.Context().Err()
	}

	request.Wait = false
	accepted, err := client.Send(command.Context(), request)
	if err != nil {
		if codexMutationMayBeUncertain(err) {
			return writeCodexUncertainAfterSend(command, request.OperationID, err, format)
		}
		return err
	}
	if accepted.State != codextask.StateAccepted {
		return writeCodexSendResult(command, accepted, format)
	}
	if completedTurnInRead(read, accepted.TurnID) {
		cancelStream()
		accepted.State = codextask.StateCompleted
		accepted.Result = read.Result
		return writeCodexSendResult(command, accepted, format)
	}

	for {
		var update codexStreamUpdate
		if firstUpdate != nil {
			update = *firstUpdate
			firstUpdate = nil
		} else {
			select {
			case update = <-updates:
			case <-command.Context().Done():
				return writeCodexUncertainAfterSend(command, request.OperationID, command.Context().Err(), format)
			}
		}
		if update.err != nil {
			return writeCodexUncertainAfterSend(command, request.OperationID, update.err, format)
		}
		if format == "ndjson" {
			if err := writeCodexJSON(command.OutOrStdout(), update.event); err != nil {
				return err
			}
		}
		if update.event.Event == nil {
			continue
		}
		terminal, complete := terminalCodexSendResult(accepted, *update.event.Event)
		if !complete {
			continue
		}
		cancelStream()
		if terminal.State == codextask.StateCompleted {
			finalRead, readErr := client.Read(command.Context(), request.ReadRequest)
			if readErr != nil || finalRead.State != codextask.StateConfirmed || finalRead.Result == nil {
				if readErr == nil {
					readErr = errors.New("final Codex thread history is unavailable")
				}
				return writeCodexUncertainAfterSend(command, request.OperationID, readErr, format)
			}
			terminal.Result = finalRead.Result
		}
		return writeCodexSendResult(command, terminal, format)
	}
}

func completedTurnInRead(read codextask.ReadResult, turnID string) bool {
	if read.Result == nil || turnID == "" {
		return false
	}
	for _, turn := range read.Result.Turns {
		if turn.ID == turnID {
			return turn.Status == "completed" || turn.Status == "failed" || turn.Status == "interrupted"
		}
	}
	return false
}

func writeCodexReadBlocked(
	command *cobra.Command,
	read codextask.ReadResult,
	operationID string,
	format string,
) error {
	blocked := codextask.SendResult{
		APIVersion:  codextask.APIVersion,
		Message:     read.Message,
		OperationID: operationID,
		Reason:      read.Reason,
		State:       codextask.StateBlocked,
	}
	return writeCodexSendResult(command, blocked, format)
}

func writeCodexSendResult(command *cobra.Command, result codextask.SendResult, format string) error {
	var err error
	if format == "ndjson" {
		err = writeCodexJSON(command.OutOrStdout(), codextask.ProgressEvent{Type: "result", Result: &result})
	} else {
		err = writeCodexJSON(command.OutOrStdout(), result)
	}
	if err != nil {
		return err
	}
	return codexResultOutcome(result.State, result.Message)
}

func writeCodexUncertainAfterSend(command *cobra.Command, operationID string, _ error, format string) error {
	uncertain := codextask.SendResult{
		APIVersion: codextask.APIVersion, Message: "The turn was accepted, but its final state could not be confirmed.",
		OperationID: operationID, Reconcile: "required", State: codextask.StateUncertain,
	}
	if err := writeCodexSendResult(command, uncertain, format); err != nil {
		var outcome *codexOutcomeError
		if !errors.As(err, &outcome) {
			return err
		}
	}
	return &codexOutcomeError{message: "Codex turn requires reconciliation"}
}

func terminalCodexSendResult(accepted codextask.SendResult, event codextask.SessionStreamEvent) (codextask.SendResult, bool) {
	result := codextask.SendResult{APIVersion: codextask.APIVersion, OperationID: accepted.OperationID}
	switch event.Type {
	case "turn-completed":
		if event.TurnID != accepted.TurnID {
			return codextask.SendResult{}, false
		}
		result.State, result.Target = codextask.StateCompleted, accepted.Target
		result.ThreadID, result.TurnID = accepted.ThreadID, accepted.TurnID
	case "approval-requested":
		if event.TurnID != accepted.TurnID {
			return codextask.SendResult{}, false
		}
		result.State, result.Reason = codextask.StateBlocked, codextask.BlockedApprovalRequired
		result.Message = "Codex requires approval."
	case "user-input-requested":
		if event.TurnID != accepted.TurnID {
			return codextask.SendResult{}, false
		}
		result.State, result.Reason = codextask.StateBlocked, codextask.BlockedInputRequired
		result.Message = "Codex requires user input."
	default:
		return codextask.SendResult{}, false
	}
	return result, true
}
