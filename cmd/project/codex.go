package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/DotNaos/project-space/internal/codextask"
	"github.com/spf13/cobra"
)

type codexTaskAPI interface {
	Authorize(context.Context, codextask.AuthorizationRequest) (codextask.AuthorizationResult, error)
	Start(context.Context, codextask.StartRequest) (codextask.StartResult, error)
	Read(context.Context, codextask.ReadRequest) (codextask.ReadResult, error)
	Send(context.Context, codextask.SendRequest) (codextask.SendResult, error)
	Stream(context.Context, codextask.SubscribeRequest, codextask.EventHandler) error
	Attach(context.Context, codextask.AttachRequest) (codextask.AttachResult, error)
}

type codexTargetOptions struct {
	connectorID   string
	environmentID string
	here          bool
	machineID     string
	machineName   string
}

type codexOutcomeError struct{ message string }

func (err *codexOutcomeError) Error() string { return err.message }

var errCodexStreamTerminal = errors.New("Codex stream reached a terminal event")

func newCodexCommand() *cobra.Command {
	return newCodexCommandWithDependencies(codexCommandDependencies{})
}

func newCodexCommandWithDependencies(dependencies codexCommandDependencies) *cobra.Command {
	dependencies = normalizeCodexCommandDependencies(dependencies)
	command := &cobra.Command{
		Use:   "codex",
		Short: "Start, inspect, continue, or attach to persistent Codex tasks",
	}
	command.AddCommand(newCodexStartCommand(dependencies))
	command.AddCommand(newCodexLoginCommand(dependencies))
	command.AddCommand(newCodexReadCommand(dependencies))
	command.AddCommand(newCodexSendCommand(dependencies))
	command.AddCommand(newCodexAttachCommand(dependencies))
	return command
}

func newCodexStartCommand(dependencies codexCommandDependencies) *cobra.Command {
	target := codexTargetOptions{}
	issue, operationID, repositoryID, format := 0, "", "", "text"
	dryRun := false
	command := &cobra.Command{
		Use:   "start",
		Short: "Start a persistent Codex task from a GitHub issue",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if repositoryID == "" {
				var err error
				repositoryID, err = dependencies.ResolveRepository(command.Context())
				if err != nil {
					return err
				}
			}
			runtime, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			selector, err := target.startSelector(runtime.localMachineName)
			if err != nil {
				return err
			}
			if issue < 1 {
				return errors.New("--issue must be a positive GitHub issue number")
			}
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			operationID, err = operationIDOrNew(operationID, "codex:start", dependencies.NewOperationID)
			if err != nil {
				return err
			}
			result, err := runtime.client.Start(command.Context(), codextask.StartRequest{
				Selector: selector, DryRun: dryRun, Issue: issue,
				OperationID: operationID, RepositoryID: repositoryID,
			})
			if err != nil {
				if codexMutationMayBeUncertain(err) {
					result = codextask.StartResult{
						APIVersion: codextask.APIVersion, Message: "The start request was sent, but its final state could not be confirmed.",
						OperationID: operationID, Reconcile: "required", State: codextask.StateUncertain,
					}
				} else {
					return err
				}
			}
			if format == "json" {
				if err := writeCodexJSON(command.OutOrStdout(), result); err != nil {
					return err
				}
			} else {
				writeCodexStartText(command.OutOrStdout(), result)
			}
			return codexResultOutcome(result.State, result.Message)
		},
	}
	command.Flags().IntVar(&issue, "issue", 0, "GitHub issue number")
	command.Flags().StringVar(&repositoryID, "repository", "", "exact GitHub owner/name or repository ID")
	command.Flags().BoolVar(&dryRun, "dry-run", false, "resolve the exact target without starting a task")
	command.Flags().StringVar(&operationID, "operation-id", "", "stable idempotency key for safe retries")
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	addCodexTargetFlags(command, &target, true)
	return command
}

func newCodexReadCommand(dependencies codexCommandDependencies) *cobra.Command {
	target := codexTargetOptions{}
	threadID, format, last := "", "json", 0
	command := &cobra.Command{
		Use:   "read",
		Short: "Read a persistent Codex thread non-interactively",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "json" {
				return errors.New("--format must be json")
			}
			selector, err := target.existingSelector()
			if err != nil {
				return err
			}
			runtime, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			result, err := runtime.client.Read(command.Context(), codextask.ReadRequest{
				Selector: selector, Last: last, ThreadID: threadID,
			})
			if err != nil {
				return err
			}
			if err := writeCodexJSON(command.OutOrStdout(), result); err != nil {
				return err
			}
			return codexResultOutcome(result.State, result.Message)
		},
	}
	command.Flags().StringVar(&threadID, "thread", "", "persistent Codex thread ID")
	command.Flags().IntVar(&last, "last", 0, "return only the last N turns")
	command.Flags().StringVar(&format, "format", "json", "output format: json")
	addCodexTargetFlags(command, &target, false)
	return command
}

func newCodexSendCommand(dependencies codexCommandDependencies) *cobra.Command {
	target := codexTargetOptions{}
	threadID, message, promptFile := "", "", ""
	operationID, format := "", "json"
	wait, noWait := false, false
	command := &cobra.Command{
		Use:   "send",
		Short: "Send a non-interactive turn to a persistent Codex thread",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "json" && format != "ndjson" {
				return errors.New("--format must be json or ndjson")
			}
			if wait && noWait {
				return errors.New("--wait and --no-wait cannot be used together")
			}
			selector, err := target.existingSelector()
			if err != nil {
				return err
			}
			prompt, err := codextask.LoadPrompt(codextask.PromptSource{
				Input: command.InOrStdin(), Message: message, PromptFile: promptFile,
			})
			if err != nil {
				return err
			}
			operationID, err = operationIDOrNew(operationID, "codex:send", dependencies.NewOperationID)
			if err != nil {
				return err
			}
			runtime, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			request := codextask.SendRequest{
				ReadRequest: codextask.ReadRequest{Selector: selector, ThreadID: threadID},
				Message:     prompt, OperationID: operationID, Wait: wait,
			}
			if wait {
				return sendCodexAndWait(command, runtime.client, request, format)
			}
			result, err := runtime.client.Send(command.Context(), request)
			if err != nil {
				if codexMutationMayBeUncertain(err) {
					return writeCodexUncertainAfterSend(command, request.OperationID, err, format)
				}
				return err
			}
			if format == "ndjson" {
				err = writeCodexJSON(command.OutOrStdout(), codextask.ProgressEvent{Type: "result", Result: &result})
			} else {
				err = writeCodexJSON(command.OutOrStdout(), result)
			}
			if err != nil {
				return err
			}
			return codexResultOutcome(result.State, result.Message)
		},
	}
	command.Flags().StringVar(&threadID, "thread", "", "persistent Codex thread ID")
	command.Flags().StringVar(&message, "message", "", "turn prompt, or - to read from standard input")
	command.Flags().StringVar(&promptFile, "prompt-file", "", "read the turn prompt from a regular file")
	command.Flags().BoolVar(&wait, "wait", false, "wait for the turn to complete or require interaction")
	command.Flags().BoolVar(&noWait, "no-wait", false, "return as soon as the turn is accepted")
	command.Flags().StringVar(&operationID, "operation-id", "", "stable idempotency key for safe retries")
	command.Flags().StringVar(&format, "format", "json", "output format: json or ndjson")
	addCodexTargetFlags(command, &target, false)
	return command
}

func addCodexTargetFlags(command *cobra.Command, target *codexTargetOptions, allowHere bool) {
	command.Flags().StringVar(&target.environmentID, "environment-id", "", "exact canonical Environment ID")
	command.Flags().StringVar(&target.machineName, "machine", "", "exact physical machine name")
	command.Flags().StringVar(&target.machineID, "machine-id", "", "exact physical machine ID")
	command.Flags().StringVar(&target.connectorID, "connector", "", "exact connector installation ID")
	if allowHere {
		command.Flags().BoolVar(&target.here, "here", false, "use the physical machine connected by this CLI")
	}
}

func (target codexTargetOptions) startSelector(localMachineName string) (codextask.Selector, error) {
	if target.environmentID != "" && target.connectorID != "" {
		return codextask.Selector{}, errors.New("--environment-id cannot be combined with the legacy --connector selector")
	}
	if target.environmentID != "" && (target.machineID != "" || target.machineName != "") {
		return codextask.Selector{}, errors.New("--environment-id cannot be combined with --machine or --machine-id")
	}
	if target.here {
		if target.environmentID != "" || target.machineID != "" || target.machineName != "" {
			return codextask.Selector{}, errors.New("--here cannot be combined with --environment-id, --machine, or --machine-id")
		}
		if strings.TrimSpace(localMachineName) == "" {
			return codextask.Selector{}, errors.New("the connected machine has no local identity")
		}
		return codextask.Selector{ConnectorID: target.connectorID}, nil
	}
	return target.selector(true)
}

func (target codexTargetOptions) existingSelector() (codextask.Selector, error) {
	return target.selector(true)
}

func (target codexTargetOptions) selector(required bool) (codextask.Selector, error) {
	if target.machineID != "" && target.machineName != "" {
		return codextask.Selector{}, errors.New("select a machine with --machine or --machine-id, not both")
	}
	if target.environmentID != "" && (target.machineID != "" || target.machineName != "") {
		return codextask.Selector{}, errors.New("select an environment or physical machine, not both")
	}
	if required && target.environmentID == "" && target.machineID == "" && target.machineName == "" {
		return codextask.Selector{}, errors.New("--environment-id, --machine, or --machine-id is required")
	}
	return codextask.Selector{
		ConnectorID: target.connectorID, EnvironmentID: target.environmentID, PhysicalMachineID: target.machineID,
		PhysicalMachineName: target.machineName,
	}, nil
}

func operationIDOrNew(current, prefix string, generate func(string) (string, error)) (string, error) {
	if strings.TrimSpace(current) != "" {
		return current, nil
	}
	return generate(prefix)
}

func writeCodexJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func writeCodexStartText(output io.Writer, result codextask.StartResult) {
	switch result.State {
	case codextask.StateReady:
		fmt.Fprintf(output, "Codex target ready: %s via %s\n", result.Target.PhysicalMachine.Name, result.Target.Connector.Name)
	case codextask.StateConfirmed:
		fmt.Fprintf(output, "Started Codex task: %s\nThread: %s\nWorktree: %s\n", result.Task.CanonicalTaskURL, result.Task.ThreadID, result.Task.Worktree.Branch)
	default:
		fmt.Fprintf(output, "Codex task %s: %s\n", result.State, result.Message)
	}
}

func codexResultOutcome(state codextask.ResultState, message string) error {
	if state != codextask.StateBlocked && state != codextask.StateUncertain {
		return nil
	}
	if strings.TrimSpace(message) == "" {
		message = "Codex task requires attention"
	}
	return &codexOutcomeError{message: message}
}

func codexMutationMayBeUncertain(err error) bool {
	return errors.Is(err, codextask.ErrUnavailable) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}
