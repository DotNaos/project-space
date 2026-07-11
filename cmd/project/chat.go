package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode"

	"github.com/DotNaos/project-space/internal/projectchat"
	"github.com/spf13/cobra"
)

const maxChatReadPages = 100

type chatCommandDependencies struct {
	IdentityProvider  projectchat.ThreadIdentityProvider
	ProfileProvider   projectchat.AgentProfileProvider
	Client            projectchat.ClientAPI
	NewIdempotencyKey func() (string, error)
}

func newChatCommand(dependencies chatCommandDependencies) *cobra.Command {
	if dependencies.NewIdempotencyKey == nil {
		dependencies.NewIdempotencyKey = newChatIdempotencyKey
	}
	cmd := &cobra.Command{
		Use:   "chat",
		Short: "Coordinate with people and agents through Project Chat",
	}
	cmd.AddCommand(newChatSendCommand(dependencies))
	cmd.AddCommand(newChatReadCommand(dependencies))
	return cmd
}

func newChatSendCommand(dependencies chatCommandDependencies) *cobra.Command {
	return &cobra.Command{
		Use:   "send <message>",
		Short: "Send one message to #general",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			threadID, profile, err := chatAgentContext(cmd.Context(), dependencies)
			if err != nil {
				return err
			}
			if dependencies.Client == nil {
				return projectchat.ErrUnavailable
			}
			if err := prepareChatParticipant(cmd.Context(), dependencies.Client, threadID, profile); err != nil {
				return err
			}
			idempotencyKey, err := dependencies.NewIdempotencyKey()
			if err != nil || idempotencyKey == "" {
				return fmt.Errorf("create Project Chat idempotency key: %w", projectchat.ErrInvalidRequest)
			}
			if _, err := dependencies.Client.Send(
				cmd.Context(),
				threadID,
				projectchat.GeneralChannel,
				args[0],
				idempotencyKey,
			); err != nil {
				return err
			}
			return writeChatOutput(cmd.OutOrStdout(), []byte("Message sent to #general.\n"))
		},
	}
}

func newChatReadCommand(dependencies chatCommandDependencies) *cobra.Command {
	return &cobra.Command{
		Use:   "read",
		Short: "Read unread messages from #general",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			threadID, profile, err := chatAgentContext(cmd.Context(), dependencies)
			if err != nil {
				return err
			}
			if dependencies.Client == nil {
				return projectchat.ErrUnavailable
			}
			if err := prepareChatParticipant(cmd.Context(), dependencies.Client, threadID, profile); err != nil {
				return err
			}
			return readProjectChat(cmd.Context(), cmd.OutOrStdout(), threadID, dependencies.Client)
		},
	}
}

func chatAgentContext(
	ctx context.Context,
	dependencies chatCommandDependencies,
) (string, projectchat.AgentProfile, error) {
	if dependencies.IdentityProvider == nil {
		return "", projectchat.AgentProfile{}, projectchat.ErrMissingThreadID
	}
	threadID, err := dependencies.IdentityProvider.ThreadID(ctx)
	if err != nil {
		return "", projectchat.AgentProfile{}, err
	}
	if dependencies.ProfileProvider == nil {
		return "", projectchat.AgentProfile{}, projectchat.ErrMissingAgentName
	}
	profile, err := dependencies.ProfileProvider.AgentProfile(ctx)
	if err != nil {
		return "", projectchat.AgentProfile{}, err
	}
	return threadID, profile, nil
}

func prepareChatParticipant(
	ctx context.Context,
	client projectchat.ClientAPI,
	threadID string,
	profile projectchat.AgentProfile,
) error {
	err := client.UpdatePresence(ctx, threadID, profile)
	if err == nil {
		return nil
	}
	if !errors.Is(err, projectchat.ErrNotRegistered) {
		return err
	}
	return client.Join(ctx, threadID, profile)
}

func readProjectChat(ctx context.Context, output io.Writer, threadID string, client projectchat.ClientAPI) error {
	wroteMessages := false
	for page := 0; page < maxChatReadPages; page++ {
		result, err := client.Read(ctx, threadID, projectchat.GeneralChannel, projectchat.DefaultReadLimit)
		if err != nil {
			return err
		}
		if len(result.Messages) == 0 {
			if result.HasMore {
				return projectchat.ErrInvalidResponse
			}
			if !wroteMessages {
				if err := writeChatOutput(output, []byte("No unread messages in #general.\n")); err != nil {
					return err
				}
			}
			if result.NextSequence > result.AfterSequence {
				return client.Acknowledge(ctx, threadID, projectchat.GeneralChannel, result.NextSequence)
			}
			return nil
		}

		formatted := formatChatMessages(result.Messages)
		if err := writeChatOutput(output, formatted); err != nil {
			return err
		}
		wroteMessages = true
		if err := client.Acknowledge(ctx, threadID, projectchat.GeneralChannel, result.NextSequence); err != nil {
			return err
		}
		if !result.HasMore {
			return nil
		}
	}
	return projectchat.ErrInvalidResponse
}

func formatChatMessages(messages []projectchat.Message) []byte {
	var output bytes.Buffer
	for _, message := range messages {
		displayName := sanitizeChatInline(message.Sender.DisplayName)
		if displayName == "" {
			displayName = "Unknown participant"
		}
		fmt.Fprintf(&output, "Message from %s\n", displayName)
		if role := sanitizeChatInline(message.Sender.Role); role != "" {
			fmt.Fprintf(&output, "Role: %s\n", role)
		}
		if message.Sender.Origin != nil && message.Sender.Origin.ThreadID != "" {
			fmt.Fprintf(&output, "Thread: %s\n", sanitizeChatInline(message.Sender.Origin.ThreadID))
			fmt.Fprintf(&output, "Host: %s\n", sanitizeChatInline(message.Sender.Origin.HostID))
			fmt.Fprintf(&output, "Machine: %s\n", sanitizeChatInline(message.Sender.Origin.MachineID))
		}
		if !message.CreatedAt.IsZero() {
			fmt.Fprintf(&output, "Time: %s\n", message.CreatedAt.UTC().Format(time.RFC3339))
		}
		fmt.Fprintf(
			&output,
			"Channel: #%s\nMessage:\n%s\nEnd message.\n\n",
			sanitizeChatInline(message.ChannelID),
			quoteChatBody(message.Body),
		)
	}
	return output.Bytes()
}

func sanitizeChatInline(value string) string {
	return strings.TrimSpace(strings.Map(func(character rune) rune {
		if unicode.IsControl(character) || unicode.Is(unicode.Bidi_Control, character) {
			return ' '
		}
		return character
	}, value))
}

func sanitizeChatBody(value string) string {
	return strings.Map(func(character rune) rune {
		if character == '\n' || character == '\t' {
			return character
		}
		if unicode.IsControl(character) || unicode.Is(unicode.Bidi_Control, character) {
			return '\uFFFD'
		}
		return character
	}, value)
}

func quoteChatBody(value string) string {
	lines := strings.Split(sanitizeChatBody(value), "\n")
	for index, line := range lines {
		lines[index] = "| " + line
	}
	return strings.Join(lines, "\n")
}

func writeChatOutput(output io.Writer, body []byte) error {
	for len(body) > 0 {
		written, err := output.Write(body)
		if written > 0 {
			body = body[written:]
		}
		if err != nil {
			return fmt.Errorf("write Project Chat output: %w", err)
		}
		if written == 0 {
			return fmt.Errorf("write Project Chat output: %w", io.ErrShortWrite)
		}
	}
	return nil
}

func newChatIdempotencyKey() (string, error) {
	random := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, random); err != nil {
		return "", err
	}
	return "chat-" + hex.EncodeToString(random), nil
}
