package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/projectchat"
)

func TestAgentNameClaimsAvailableProjectSpaceName(t *testing.T) {
	store := &capturingAgentProfileStore{}
	registry := &automaticNameRegistry{
		catalog: automaticNameCatalog("Athena", "Hermes"),
	}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		ProfileStore:     store,
		Registry:         registry,
		RandomIndex:      func(int) int { return 0 },
	})
	command.SetArgs([]string{"name", "--format", "json"})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	result := decodeAgentNameResult(t, stdout)
	if result.Name != "Athena" || result.Source != "project-space" || result.Warning != "" {
		t.Fatalf("result = %#v", result)
	}
	if stderr.Len() != 0 || len(registry.claimed) != 1 || registry.claimed[0] != "Athena" {
		t.Fatalf("stderr = %q, claims = %#v", stderr, registry.claimed)
	}
	if !store.saved.RegistryClaim || store.saved.DisplayName != "Athena" {
		t.Fatalf("saved profile = %#v", store.saved)
	}
}

func TestAgentNameAvoidsVisibleNamesAndRetriesClaimConflict(t *testing.T) {
	registry := &automaticNameRegistry{
		catalog:   automaticNameCatalog("Athena", "Hermes", "Nyx"),
		claimErrs: map[string]error{"Hermes": projectchat.ErrNameConflict},
	}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         registry,
		RandomIndex:      func(int) int { return 0 },
	})
	command.SetArgs([]string{"name", "--exclude", "athena", "--format", "json"})
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	result := decodeAgentNameResult(t, stdout)
	if result.Name != "Nyx" || result.Source != "project-space" {
		t.Fatalf("result = %#v", result)
	}
	if strings.Join(registry.claimed, ",") != "Hermes,Nyx" {
		t.Fatalf("claim attempts = %#v", registry.claimed)
	}
}

func TestAgentNameKeepsCurrentClaimUnlessVisibleNameExcludesIt(t *testing.T) {
	catalog := automaticNameCatalog("Hermes")
	catalog.Groups[0].Names = append([]projectchat.NameEntry{{
		Name: "Athena", Category: projectchat.NameCategoryMythology,
		State: "claimed", ClaimedByCurrentThread: true,
	}}, catalog.Groups[0].Names...)
	registry := &automaticNameRegistry{catalog: catalog}

	first := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID), Registry: registry,
		RandomIndex: func(maximum int) int { return maximum - 1 },
	})
	first.SetArgs([]string{"name"})
	firstOut := &bytes.Buffer{}
	first.SetOut(firstOut)
	first.SetErr(&bytes.Buffer{})
	if err := first.Execute(); err != nil || strings.TrimSpace(firstOut.String()) != "Athena" {
		t.Fatalf("first output = %q, error = %v", firstOut, err)
	}

	second := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID), Registry: registry,
		RandomIndex: func(int) int { return 0 },
	})
	second.SetArgs([]string{"name", "--exclude", "Athena"})
	secondOut := &bytes.Buffer{}
	second.SetOut(secondOut)
	second.SetErr(&bytes.Buffer{})
	if err := second.Execute(); err != nil || strings.TrimSpace(secondOut.String()) != "Hermes" {
		t.Fatalf("second output = %q, error = %v", secondOut, err)
	}
}

func TestAgentNameReusesStoredFallbackWhileOffline(t *testing.T) {
	store := &capturingAgentProfileStore{saved: projectchat.AgentProfile{DisplayName: "Selria-7KQ4NP"}}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		ProfileStore:     store,
		FallbackName:     func(string, int) string { return "Different-222222" },
	})
	command.SetArgs([]string{"name"})
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(stdout.String()) != "Selria-7KQ4NP" {
		t.Fatalf("output = %q", stdout)
	}
}

func TestAgentNameFallsBackWithoutConnectionAndWarns(t *testing.T) {
	command := newAgentCommand(agentNameDependencies{
		FallbackName: func(string, int) string { return "Selria-7KQ4NP" },
	})
	command.SetArgs([]string{"name", "--format", "json"})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	result := decodeAgentNameResult(t, stdout)
	if result.Name != "Selria-7KQ4NP" || result.Source != "fallback" || result.Warning != agentNameFallbackWarning {
		t.Fatalf("result = %#v", result)
	}
	if !strings.Contains(stderr.String(), agentNameFallbackWarning) {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestAgentNameFallbackRetriesVisibleCollision(t *testing.T) {
	names := []string{"Mira", "Wenren-9R4K2P"}
	command := newAgentCommand(agentNameDependencies{
		FallbackName: func(string, int) string {
			name := names[0]
			names = names[1:]
			return name
		},
	})
	command.SetArgs([]string{"name", "--exclude", "mira"})
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(stdout.String()) != "Wenren-9R4K2P" {
		t.Fatalf("output = %q", stdout)
	}
}

func TestAgentNameFallsBackWhenRegistryIsUnavailable(t *testing.T) {
	registry := &automaticNameRegistry{listErr: projectchat.ErrUnavailable}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         registry,
		FallbackName:     func(string, int) string { return "Aeden-222222" },
	})
	command.SetArgs([]string{"name"})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)

	if err := command.Execute(); err != nil || strings.TrimSpace(stdout.String()) != "Aeden-222222" {
		t.Fatalf("output = %q, error = %v", stdout, err)
	}
	if !strings.Contains(stderr.String(), agentNameFallbackWarning) {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestAgentNameFallsBackAfterOnlineDeadline(t *testing.T) {
	registry := &automaticNameRegistry{waitForCancellation: true}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         registry,
		FallbackName:     func(string, int) string { return "Aeden-222222" },
		OnlineTimeout:    time.Millisecond,
	})
	command.SetArgs([]string{"name"})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)

	if err := command.Execute(); err != nil || strings.TrimSpace(stdout.String()) != "Aeden-222222" {
		t.Fatalf("output = %q, error = %v", stdout, err)
	}
	if !strings.Contains(stderr.String(), agentNameFallbackWarning) {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestGeneratedFallbackNameIsCompactAndStableShape(t *testing.T) {
	name := generateFallbackAgentName(func(int) int { return 0 })
	if name != "Aeden-222222" {
		t.Fatalf("name = %q", name)
	}
}

func TestDeterministicFallbackNameIsStablePerThread(t *testing.T) {
	first := deterministicFallbackAgentName(chatTestThreadID, 0)
	second := deterministicFallbackAgentName(chatTestThreadID, 0)
	differentThread := deterministicFallbackAgentName("019f5a03-aab4-75e2-8193-375273244af3", 0)
	if first != second || first == differentThread {
		t.Fatalf("first = %q, second = %q, different = %q", first, second, differentThread)
	}
}

func TestAgentNameRejectsUnknownFormat(t *testing.T) {
	command := newAgentCommand(agentNameDependencies{})
	command.SetArgs([]string{"name", "--format", "yaml"})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "--format") {
		t.Fatalf("error = %v", err)
	}
}

func TestDefaultAgentNameRuntimeFallsBackWithoutMachineCredential(t *testing.T) {
	command := newDefaultAgentCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: func(key string) (string, bool) {
			if key == "CODEX_THREAD_ID" {
				return chatTestThreadID, true
			}
			return "", false
		},
		NewCredentialStore: func() (machineconnect.CredentialStore, error) {
			return nil, errors.New("not connected")
		},
		NewProfileStore: func() (projectchat.AgentProfileStore, error) {
			return &capturingAgentProfileStore{}, nil
		},
	})
	command.SetArgs([]string{"name"})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)

	if err := command.Execute(); err != nil || strings.TrimSpace(stdout.String()) == "" {
		t.Fatalf("output = %q, error = %v", stdout, err)
	}
	if !strings.Contains(stderr.String(), agentNameFallbackWarning) {
		t.Fatalf("stderr = %q", stderr)
	}
}

func fixedThreadIdentityProvider(threadID string) projectchat.ThreadIdentityProvider {
	return projectchat.ThreadIdentityProviderFunc(func(context.Context) (string, error) {
		return threadID, nil
	})
}

type automaticNameRegistry struct {
	catalog             projectchat.NameCatalog
	listErr             error
	claimErrs           map[string]error
	claimed             []string
	waitForCancellation bool
}

func (registry *automaticNameRegistry) ListNames(ctx context.Context, _ string) (projectchat.NameCatalog, error) {
	if registry.waitForCancellation {
		<-ctx.Done()
		return projectchat.NameCatalog{}, ctx.Err()
	}
	return registry.catalog, registry.listErr
}

func (registry *automaticNameRegistry) ClaimName(
	_ context.Context,
	threadID string,
	name string,
	category projectchat.NameCategory,
	_ string,
) (projectchat.NameClaim, error) {
	registry.claimed = append(registry.claimed, name)
	if err := registry.claimErrs[name]; err != nil {
		return projectchat.NameClaim{}, err
	}
	return projectchat.NameClaim{
		Name: name, DisplayName: name, Category: category, ThreadID: threadID,
	}, nil
}

func automaticNameCatalog(names ...string) projectchat.NameCatalog {
	entries := make([]projectchat.NameEntry, 0, len(names))
	for _, name := range names {
		entries = append(entries, projectchat.NameEntry{
			Name: name, Category: projectchat.NameCategoryMythology, State: "available",
		})
	}
	return projectchat.NameCatalog{Groups: []projectchat.NameGroup{{
		Category: projectchat.NameCategoryMythology,
		Names:    entries,
	}}}
}

type capturingAgentProfileStore struct {
	saved projectchat.AgentProfile
}

func (store *capturingAgentProfileStore) Load(string) (projectchat.AgentProfile, error) {
	if store.saved.DisplayName == "" {
		return projectchat.AgentProfile{}, projectchat.ErrAgentProfileNotFound
	}
	return store.saved, nil
}

func (store *capturingAgentProfileStore) Save(_ string, profile projectchat.AgentProfile) error {
	store.saved = profile
	return nil
}

func decodeAgentNameResult(t *testing.T, output *bytes.Buffer) agentNameResult {
	t.Helper()
	result := agentNameResult{}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("decode output %q: %v", output, err)
	}
	return result
}
