package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/DotNaos/project-space/internal/projectchat"
	"github.com/spf13/cobra"
)

const agentNameFallbackWarning = "Project Space is not reachable. Wir haben jetzt einfach einen zufälligen Namen generiert, den du jetzt verwendest."
const defaultAgentNameOnlineTimeout = 4 * time.Second

var fallbackEntropyCounter atomic.Uint64

type agentNameDependencies struct {
	IdentityProvider projectchat.ThreadIdentityProvider
	ProfileStore     projectchat.AgentProfileStore
	Registry         projectchat.NameRegistryClient
	RandomIndex      func(int) int
	FallbackName     func(string, int) string
	OnlineTimeout    time.Duration
}

type agentNameResult struct {
	Name    string `json:"name"`
	Source  string `json:"source"`
	Warning string `json:"warning"`
}

func newAgentCommand(dependencies agentNameDependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "agent",
		Short: "Manage the current Codex agent identity",
	}
	cmd.AddCommand(newAgentNameCommand(dependencies))
	return cmd
}

func newAgentNameCommand(dependencies agentNameDependencies) *cobra.Command {
	if dependencies.RandomIndex == nil {
		dependencies.RandomIndex = secureAgentNameIndex
	}
	if dependencies.FallbackName == nil {
		dependencies.FallbackName = func(threadID string, attempt int) string {
			if threadID != "" {
				return deterministicFallbackAgentName(threadID, attempt)
			}
			return generateFallbackAgentName(dependencies.RandomIndex)
		}
	}

	var excludedNames []string
	var format string
	cmd := &cobra.Command{
		Use:   "name",
		Short: "Claim a unique Codex agent name, with an offline fallback",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			result := allocateAgentName(cmd.Context(), dependencies, excludedNames)
			return writeAgentNameResult(cmd, format, result)
		},
	}
	cmd.Flags().StringArrayVar(&excludedNames, "exclude", nil, "agent name already used by a visible Codex task (repeatable)")
	cmd.Flags().StringVar(&format, "format", "text", "output format: text or json")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("text", "json")))
	return cmd
}

func allocateAgentName(
	ctx context.Context,
	dependencies agentNameDependencies,
	excludedNames []string,
) agentNameResult {
	excluded := normalizedAgentNames(excludedNames)
	timeout := dependencies.OnlineTimeout
	if timeout <= 0 {
		timeout = defaultAgentNameOnlineTimeout
	}
	onlineContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if name, ok := claimProjectSpaceAgentName(onlineContext, dependencies, excluded); ok {
		return agentNameResult{Name: name, Source: "project-space"}
	}
	name := storedOrGeneratedFallbackAgentName(ctx, dependencies, excluded)
	return agentNameResult{
		Name:    name,
		Source:  "fallback",
		Warning: agentNameFallbackWarning,
	}
}

func storedOrGeneratedFallbackAgentName(
	ctx context.Context,
	dependencies agentNameDependencies,
	excluded map[string]struct{},
) string {
	threadID := ""
	if dependencies.IdentityProvider != nil {
		threadID, _ = dependencies.IdentityProvider.ThreadID(ctx)
	}
	if threadID != "" && dependencies.ProfileStore != nil {
		profile, err := dependencies.ProfileStore.Load(threadID)
		if err == nil && strings.TrimSpace(profile.DisplayName) != "" {
			if _, found := excluded[normalizeAgentName(profile.DisplayName)]; !found {
				return profile.DisplayName
			}
		}
	}
	name := uniqueFallbackAgentName(threadID, excluded, dependencies.FallbackName)
	if threadID != "" && dependencies.ProfileStore != nil {
		_ = dependencies.ProfileStore.Save(threadID, projectchat.AgentProfile{DisplayName: name})
	}
	return name
}

func claimProjectSpaceAgentName(
	ctx context.Context,
	dependencies agentNameDependencies,
	excluded map[string]struct{},
) (string, bool) {
	if dependencies.IdentityProvider == nil || dependencies.Registry == nil {
		return "", false
	}
	threadID, err := dependencies.IdentityProvider.ThreadID(ctx)
	if err != nil {
		return "", false
	}
	catalog, err := dependencies.Registry.ListNames(ctx, threadID)
	if err != nil {
		return "", false
	}
	candidates := availableMainAgentNames(catalog, excluded)
	for len(candidates) > 0 {
		index := dependencies.RandomIndex(len(candidates))
		candidate := candidates[index]
		candidates = append(candidates[:index], candidates[index+1:]...)
		claim, claimErr := dependencies.Registry.ClaimName(
			ctx,
			threadID,
			candidate,
			projectchat.NameCategoryMythology,
			"",
		)
		if errors.Is(claimErr, projectchat.ErrNameConflict) {
			continue
		}
		if claimErr != nil || strings.TrimSpace(claim.Name) == "" {
			return "", false
		}
		if dependencies.ProfileStore != nil {
			_ = dependencies.ProfileStore.Save(threadID, projectchat.AgentProfile{
				DisplayName:   claim.DisplayName,
				Category:      claim.Category,
				RegistryClaim: true,
			})
		}
		return claim.Name, true
	}
	return "", false
}

func availableMainAgentNames(
	catalog projectchat.NameCatalog,
	excluded map[string]struct{},
) []string {
	current := make([]string, 0, 1)
	available := make([]string, 0)
	for _, group := range catalog.Groups {
		if group.Category != projectchat.NameCategoryMythology {
			continue
		}
		for _, entry := range group.Names {
			if _, found := excluded[normalizeAgentName(entry.Name)]; found {
				continue
			}
			if entry.ClaimedByCurrentThread {
				current = append(current, entry.Name)
			} else if entry.State == "available" {
				available = append(available, entry.Name)
			}
		}
	}
	if len(current) > 0 {
		return current
	}
	return available
}

func normalizedAgentNames(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		if normalized := normalizeAgentName(value); normalized != "" {
			result[normalized] = struct{}{}
		}
	}
	return result
}

func normalizeAgentName(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func uniqueFallbackAgentName(
	threadID string,
	excluded map[string]struct{},
	generate func(string, int) string,
) string {
	for attempt := range 256 {
		candidate := strings.TrimSpace(generate(threadID, attempt))
		if candidate == "" {
			continue
		}
		if _, found := excluded[normalizeAgentName(candidate)]; !found {
			return candidate
		}
	}
	for attempt := uint64(0); ; attempt++ {
		candidate := fmt.Sprintf("Agent-%X-%X", uint64(time.Now().UnixNano()), fallbackEntropyCounter.Add(1)+attempt+uint64(os.Getpid()))
		if _, found := excluded[normalizeAgentName(candidate)]; !found {
			return candidate
		}
	}
}

func deterministicFallbackAgentName(threadID string, attempt int) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", threadID, attempt)))
	return fallbackAgentNameFromIndexes(func(position, maximum int) int {
		return int(digest[position]) % maximum
	})
}

func generateFallbackAgentName(randomIndex func(int) int) string {
	return fallbackAgentNameFromIndexes(func(_ int, maximum int) int {
		return randomIndex(maximum)
	})
}

func fallbackAgentNameFromIndexes(index func(int, int) int) string {
	prefixes := [...]string{
		"Ae", "Al", "Ar", "Bel", "Bri", "Ca", "Cor", "Da",
		"El", "Fa", "Fen", "Gal", "Hal", "Is", "Jo", "Ka",
		"Kel", "La", "Lor", "Ma", "Mer", "Na", "Nor", "Or",
		"Per", "Quin", "Ra", "Sel", "Tal", "Val", "Wen", "Ze",
	}
	suffixes := [...]string{
		"den", "dra", "el", "en", "er", "ia", "ian", "il",
		"in", "io", "is", "on", "or", "os", "ra", "ran",
		"ren", "ria", "ric", "rin", "ro", "sa", "sel", "sor",
		"ta", "th", "tor", "va", "ven", "yn", "yor", "zen",
	}
	const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	var code strings.Builder
	code.Grow(6)
	for position := range 6 {
		code.WriteByte(alphabet[index(position+2, len(alphabet))])
	}
	return prefixes[index(0, len(prefixes))] + suffixes[index(1, len(suffixes))] + "-" + code.String()
}

func secureAgentNameIndex(maximum int) int {
	if maximum <= 1 {
		return 0
	}
	value, err := rand.Int(rand.Reader, big.NewInt(int64(maximum)))
	if err == nil {
		return int(value.Int64())
	}
	entropy := uint64(time.Now().UnixNano()) + fallbackEntropyCounter.Add(1) + uint64(os.Getpid())
	return int(entropy % uint64(maximum))
}

func writeAgentNameResult(cmd *cobra.Command, format string, result agentNameResult) error {
	if result.Warning != "" {
		fmt.Fprintf(cmd.ErrOrStderr(), "WARNING: %s\n", result.Warning)
	}
	if format == "json" {
		return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
	}
	_, err := fmt.Fprintln(cmd.OutOrStdout(), result.Name)
	return err
}
