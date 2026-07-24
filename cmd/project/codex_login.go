package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DotNaos/project-space/internal/codextask"
	"github.com/spf13/cobra"
)

func newCodexLoginCommand(dependencies codexCommandDependencies) *cobra.Command {
	target := codexTargetOptions{}
	format, operationID := "text", ""
	cancel, noWait, status := false, false, false
	command := &cobra.Command{
		Use:   "login",
		Short: "Authorize managed Codex on a remote WSL connector",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			if cancel && status {
				return errors.New("--cancel and --status cannot be combined")
			}
			if noWait && (cancel || status) {
				return errors.New("--no-wait is only valid when starting authorization")
			}
			selector, err := target.existingSelector()
			if err != nil {
				return err
			}
			action := codextask.AuthorizationStart
			if cancel {
				action = codextask.AuthorizationCancel
			} else if status {
				action = codextask.AuthorizationStatus
			}
			if action != codextask.AuthorizationStart && operationID == "" {
				return errors.New("--operation-id is required with --status or --cancel")
			}
			operationID, err = operationIDOrNew(
				operationID,
				"codex:login",
				dependencies.NewOperationID,
			)
			if err != nil {
				return err
			}
			runtime, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			result, err := runtime.client.Authorize(
				command.Context(),
				codextask.AuthorizationRequest{
					Selector: selector, Action: action, OperationID: operationID,
				},
			)
			if err != nil {
				return err
			}
			if action != codextask.AuthorizationStart || noWait ||
				result.State != codextask.AuthorizationPending {
				return writeCodexAuthorizationResult(command, result, format)
			}
			writeCodexAuthorizationInstructions(command, result, format)
			for attempt := 0; attempt < dependencies.AuthorizationPollAttempts; attempt++ {
				if deadlineReached(result.DeadlineAt) {
					break
				}
				if err := dependencies.Wait(
					command.Context(),
					dependencies.AuthorizationPollInterval,
				); err != nil {
					return err
				}
				result, err = runtime.client.Authorize(
					command.Context(),
					codextask.AuthorizationRequest{
						Selector:    selector,
						Action:      codextask.AuthorizationStatus,
						OperationID: operationID,
					},
				)
				if err != nil {
					return err
				}
				if result.State != codextask.AuthorizationPending {
					return writeCodexAuthorizationResult(command, result, format)
				}
			}
			result, err = runtime.client.Authorize(
				command.Context(),
				codextask.AuthorizationRequest{
					Selector:    selector,
					Action:      codextask.AuthorizationCancel,
					OperationID: operationID,
				},
			)
			if err != nil {
				return err
			}
			if err := writeCodexAuthorizationResult(command, result, format); err != nil {
				return err
			}
			return &codexOutcomeError{
				message: "Codex authorization was not completed before the device-code deadline",
			}
		},
	}
	command.Flags().BoolVar(&cancel, "cancel", false, "cancel the selected authorization attempt")
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	command.Flags().BoolVar(&noWait, "no-wait", false, "return after creating the device code")
	command.Flags().StringVar(
		&operationID,
		"operation-id",
		"",
		"stable idempotency key for start, status, and cancellation",
	)
	command.Flags().BoolVar(&status, "status", false, "read the selected authorization attempt")
	addCodexTargetFlags(command, &target, false)
	return command
}

func writeCodexAuthorizationInstructions(
	command *cobra.Command,
	result codextask.AuthorizationResult,
	format string,
) {
	output := command.OutOrStdout()
	if format == "json" {
		output = command.ErrOrStderr()
	}
	fmt.Fprintf(
		output,
		"Open %s and enter code %s\nAuthorization operation: %s\n",
		result.VerificationURL,
		result.UserCode,
		result.OperationID,
	)
}

func writeCodexAuthorizationResult(
	command *cobra.Command,
	result codextask.AuthorizationResult,
	format string,
) error {
	if format == "json" {
		if err := writeCodexJSON(command.OutOrStdout(), result); err != nil {
			return err
		}
	} else {
		if result.State == codextask.AuthorizationPending {
			writeCodexAuthorizationInstructions(command, result, format)
		} else {
			fmt.Fprintf(
				command.OutOrStdout(),
				"Codex authorization: %s\n%s\n",
				result.State,
				result.Message,
			)
		}
	}
	if result.State == codextask.AuthorizationReady ||
		result.State == codextask.AuthorizationPending {
		return nil
	}
	message := strings.TrimSpace(result.Message)
	if message == "" {
		message = "Codex authorization requires attention"
	}
	return &codexOutcomeError{message: message}
}

func deadlineReached(value string) bool {
	deadline, err := time.Parse(time.RFC3339, value)
	return err == nil && !time.Now().Before(deadline)
}
