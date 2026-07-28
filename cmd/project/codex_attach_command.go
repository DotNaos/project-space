package main

import (
	"errors"
	"fmt"

	"github.com/DotNaos/project-space/internal/codextask"
	"github.com/spf13/cobra"
)

func newCodexAttachCommand(dependencies codexCommandDependencies) *cobra.Command {
	target := codexTargetOptions{}
	threadID, operationID, explicitBinary := "", "", ""
	command := &cobra.Command{
		Use:   "attach",
		Short: "Attach the Codex TUI to an existing persistent thread",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			selector, err := target.existingSelector()
			if err != nil {
				return err
			}
			binary, err := dependencies.ResolveBinary(command.Context(), explicitBinary)
			if err != nil {
				return err
			}
			operationID, err = operationIDOrNew(operationID, "codex:attach", dependencies.NewOperationID)
			if err != nil {
				return err
			}
			runtime, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			lease, err := runtime.client.Attach(command.Context(), codextask.AttachRequest{
				ReadRequest: codextask.ReadRequest{Selector: selector, ThreadID: threadID},
				OperationID: operationID,
			})
			if err != nil {
				return err
			}
			if lease.State != codextask.StateConfirmed {
				fmt.Fprintf(command.OutOrStdout(), "Codex attach %s: %s\n", lease.State, lease.Message)
				return codexResultOutcome(lease.State, lease.Message)
			}
			if lease.Transport != "local-unix" {
				if lease.Transport != "websocket-tunnel" || lease.RemoteURL == "" || lease.Token == "" ||
					lease.TokenEnvironmentVariable != "PROJECT_CODEX_ATTACH_TOKEN" {
					return errors.New("the secured Codex attach tunnel is invalid")
				}
				return dependencies.AttachRemote(
					command.Context(), binary, lease.RemoteURL, lease.Token, lease.ThreadID,
					command.InOrStdin(), command.OutOrStdout(), command.ErrOrStderr(),
				)
			}
			return dependencies.AttachLocal(
				command.Context(), binary, lease.ThreadID,
				command.InOrStdin(), command.OutOrStdout(), command.ErrOrStderr(),
			)
		},
	}
	command.Flags().StringVar(&threadID, "thread", "", "persistent Codex thread ID")
	command.Flags().StringVar(&operationID, "operation-id", "", "stable idempotency key for safe retries")
	command.Flags().StringVar(&explicitBinary, "codex-binary", "", "explicit Codex CLI binary path")
	addCodexTargetFlags(command, &target, false)
	registerDirectoryCompletions(command, dependencies.Directory, &target)
	return command
}
