package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/DotNaos/project-space/internal/projectchat"
	"github.com/spf13/cobra"
)

func newChatNamesCommand(dependencies chatCommandDependencies) *cobra.Command {
	return &cobra.Command{
		Use: "names", Short: "List Project Chat registry names and availability", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			threadID, err := chatThreadID(cmd, dependencies)
			if err != nil {
				return err
			}
			if dependencies.Registry == nil {
				return projectchat.ErrUnavailable
			}
			catalog, err := dependencies.Registry.ListNames(cmd.Context(), threadID)
			if err != nil {
				return err
			}
			var output strings.Builder
			for _, group := range catalog.Groups {
				fmt.Fprintf(&output, "%s:\n", group.Category)
				for _, entry := range group.Names {
					state := entry.State
					if entry.ClaimedByCurrentThread {
						state = "claimed by this thread"
					}
					fmt.Fprintf(&output, "  %-18s %s\n", entry.Name, state)
				}
			}
			return writeChatOutput(cmd.OutOrStdout(), []byte(output.String()))
		},
	}
}

func newChatClaimCommand(dependencies chatCommandDependencies) *cobra.Command {
	var parentThreadID string
	cmd := &cobra.Command{
		Use: "claim <registry-name>", Short: "Claim an available registry name for this Codex thread", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			threadID, err := chatThreadID(cmd, dependencies)
			if err != nil {
				return err
			}
			if dependencies.Registry == nil || dependencies.ProfileStore == nil {
				return projectchat.ErrUnavailable
			}
			catalog, err := dependencies.Registry.ListNames(cmd.Context(), threadID)
			if err != nil {
				return err
			}
			entry, found := findRegistryName(catalog, args[0])
			if !found {
				return fmt.Errorf("%w: run project chat names to choose a listed name", projectchat.ErrInvalidAgentName)
			}
			if entry.Category == projectchat.NameCategoryMythology && parentThreadID != "" {
				return fmt.Errorf("%w: mythology names are for main agents and must not have --parent-thread", projectchat.ErrNameRoleForbidden)
			}
			if entry.Category != projectchat.NameCategoryMythology && parentThreadID == "" {
				return fmt.Errorf("%w: specialist names require --parent-thread <main-agent-thread-id>", projectchat.ErrNameRoleForbidden)
			}
			claim, err := dependencies.Registry.ClaimName(cmd.Context(), threadID, entry.Name, entry.Category, parentThreadID)
			if err != nil {
				if errors.Is(err, projectchat.ErrNameConflict) {
					return fmt.Errorf("%w; run project chat names to choose another available name", err)
				}
				return err
			}
			profile := projectchat.AgentProfile{DisplayName: claim.DisplayName, Category: claim.Category, ParentThreadID: claim.ParentThreadID, RegistryClaim: true}
			if err := dependencies.ProfileStore.Save(threadID, profile); err != nil {
				return fmt.Errorf("name was claimed on the server but could not be saved locally: %w", err)
			}
			return writeChatOutput(cmd.OutOrStdout(), []byte(fmt.Sprintf("Project Chat name claimed as %s for this Codex thread.\n", claim.Name)))
		},
	}
	cmd.Flags().StringVar(&parentThreadID, "parent-thread", "", "main-agent thread ID (required for specialist names)")
	return cmd
}

func chatThreadID(cmd *cobra.Command, dependencies chatCommandDependencies) (string, error) {
	if dependencies.IdentityProvider == nil {
		return "", projectchat.ErrMissingThreadID
	}
	return dependencies.IdentityProvider.ThreadID(cmd.Context())
}

func findRegistryName(catalog projectchat.NameCatalog, requested string) (projectchat.NameEntry, bool) {
	wanted := strings.TrimSpace(requested)
	for _, group := range catalog.Groups {
		for _, entry := range group.Names {
			if strings.EqualFold(entry.Name, wanted) {
				return entry, true
			}
		}
	}
	return projectchat.NameEntry{}, false
}
