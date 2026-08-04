package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/projectchat"
)

func TestAgentNameClaimsAvailableProjectSpaceName(t *testing.T) {
	store := &capturingAgentProfileStore{}
	registry := &automaticNameRegistry{catalog: automaticNameCatalog("Athena", "Hermes")}
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
	if stderr.Len() != 0 || strings.Join(registry.claimed, ",") != "Athena" {
		t.Fatalf("stderr = %q, claims = %#v", stderr, registry.claimed)
	}
	if !store.saved.RegistryClaim || store.saved.DisplayName != "Athena" {
		t.Fatalf("saved profile = %#v", store.saved)
	}
}

func TestDefaultAgentNameRuntimeClaimsThroughProjectSpaceHTTP(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer machine-token-v1" ||
			request.Header.Get("X-Project-Machine-ID") != "machine-secure-1" ||
			request.Header.Get("X-Codex-Thread-ID") != chatTestThreadID {
			http.Error(response, "invalid identity", http.StatusUnauthorized)
			return
		}
		requests = append(requests, request.Method+" "+request.URL.Path)
		response.Header().Set("Content-Type", "application/json")
		switch request.Method + " " + request.URL.Path {
		case "GET /api/project-chat/names":
			_, _ = response.Write([]byte(`{"groups":[{"category":"mythology","names":[{"name":"Apollo","category":"mythology","state":"available"}]}]}`))
		case "POST /api/project-chat/name-claims":
			_, _ = response.Write([]byte(`{"claim":{"name":"Apollo","displayName":"Apollo","category":"mythology","threadId":"` + chatTestThreadID + `"}}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	store := &chatRuntimeCredentialStore{credential: machineconnect.Credential{
		BackendURL: server.URL,
		MachineID:  "machine-secure-1",
		Token:      "machine-token-v1",
	}}
	profiles := &capturingAgentProfileStore{}
	command := newDefaultAgentCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: func(key string) (string, bool) {
			if key == "CODEX_THREAD_ID" {
				return chatTestThreadID, true
			}
			return "", false
		},
		NewCredentialStore: func() (machineconnect.CredentialStore, error) {
			return store, nil
		},
		NewProfileStore: func() (projectchat.AgentProfileStore, error) {
			return profiles, nil
		},
	})
	command.SetArgs([]string{"name", "--format", "json"})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	result := decodeAgentNameResult(t, stdout)
	if result.Name != "Apollo" || result.Source != "project-space" || result.Warning != "" {
		t.Fatalf("result = %#v", result)
	}
	if strings.Join(requests, ",") != "GET /api/project-chat/names,POST /api/project-chat/name-claims" {
		t.Fatalf("requests = %#v", requests)
	}
	if stderr.Len() != 0 || profiles.saved.DisplayName != "Apollo" ||
		!profiles.saved.RegistryClaim {
		t.Fatalf("stderr = %q, profile = %#v", stderr, profiles.saved)
	}
}

func TestAgentNameKeepsCurrentProjectSpaceClaimStable(t *testing.T) {
	catalog := automaticNameCatalog("Hermes")
	catalog.Groups[0].Names = append([]projectchat.NameEntry{{
		Name:                   "Athena",
		Category:               projectchat.NameCategoryMythology,
		State:                  "claimed",
		ClaimedByCurrentThread: true,
	}}, catalog.Groups[0].Names...)
	registry := &automaticNameRegistry{catalog: catalog}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         registry,
		RandomIndex:      func(maximum int) int { return maximum - 1 },
	})
	command.SetArgs([]string{"name"})
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(stdout.String()) != "Athena" || strings.Join(registry.claimed, ",") != "Athena" {
		t.Fatalf("output = %q, claims = %#v", stdout, registry.claimed)
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

func TestAgentNameReadsExclusionsFromBoundedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "excluded.txt")
	if err := os.WriteFile(path, []byte("Athena\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	registry := &automaticNameRegistry{catalog: automaticNameCatalog("Athena", "Hermes")}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         registry, RandomIndex: func(int) int { return 0 },
	})
	command.SetArgs([]string{"name", "--exclude-file", path, "--format", "json"})
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if result := decodeAgentNameResult(t, stdout); result.Name != "Hermes" {
		t.Fatalf("result = %#v", result)
	}
}

func TestAgentNameUsesOneServerSideAutomaticAllocation(t *testing.T) {
	registry := &automaticNameRegistry{catalog: automaticNameCatalog()}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         registry,
	})
	command.SetArgs([]string{"name", "--exclude", "Aebaden", "--format", "json"})
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	result := decodeAgentNameResult(t, stdout)
	if result.Source != "project-space" || result.Name == "" {
		t.Fatalf("result = %#v", result)
	}
	if registry.automaticClaimCalls != 1 || len(registry.claimed) != 0 {
		t.Fatalf("automatic calls = %d, ordinary claims = %#v", registry.automaticClaimCalls, registry.claimed)
	}
	if len(registry.automaticExcluded) != 1 || registry.automaticExcluded[0] != "aebaden" {
		t.Fatalf("automatic exclusions = %#v", registry.automaticExcluded)
	}
}

func TestAgentNamePrefersTheExistingOfflineNameWhenConnectivityReturns(t *testing.T) {
	t.Setenv(preferredAgentNameEnvironment, "Aebaden")
	registry := &automaticNameRegistry{catalog: automaticNameCatalog("Athena")}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID), Registry: registry,
	})
	command.SetArgs([]string{"name", "--format", "json"})
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if result := decodeAgentNameResult(t, stdout); result.Name != "Aebaden" {
		t.Fatalf("result = %#v", result)
	}
	if registry.automaticPreferred != "Aebaden" || registry.automaticClaimCalls != 1 || len(registry.claimed) != 0 {
		t.Fatalf("preferred = %q, automatic calls = %d, ordinary claims = %#v", registry.automaticPreferred, registry.automaticClaimCalls, registry.claimed)
	}
}

func TestAgentNameFallsBackOnlyWhenProjectSpaceIsUnreachable(t *testing.T) {
	registry := &automaticNameRegistry{listErr: projectchat.ErrUnavailable}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         registry,
		FallbackName:     func(string, int) string { return "Selria-7KQ4NP" },
	})
	command.SetArgs([]string{"name", "--format", "json"})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)

	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	result := decodeAgentNameResult(t, stdout)
	if result.Name != "Selria-7KQ4NP" || result.Source != "fallback" ||
		result.Warning != agentNameFallbackWarning {
		t.Fatalf("result = %#v", result)
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

func TestAgentNameDoesNotMisreportCapabilityFailuresAsOutages(t *testing.T) {
	tests := []struct {
		name     string
		listErr  error
		claimErr error
		catalog  projectchat.NameCatalog
		want     string
	}{
		{name: "authentication", listErr: projectchat.ErrUnauthorized, want: "reconnect"},
		{name: "missing credential", listErr: projectchat.ErrMissingCredential, want: "project connect"},
		{name: "unsupported server", listErr: projectchat.ErrNotRegistered, want: "does not support"},
		{name: "malformed response", listErr: projectchat.ErrInvalidResponse, want: "incompatible"},
		{name: "rate limited", listErr: projectchat.ErrRateLimited, want: "rate-limited"},
		{name: "caller cancelled", listErr: context.Canceled, want: "context canceled"},
		{name: "exhausted reservations", catalog: automaticNameCatalog(), claimErr: projectchat.ErrNameConflict, want: "no available main-agent names"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			command := newAgentCommand(agentNameDependencies{
				IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
				Registry: &automaticNameRegistry{
					catalog:  test.catalog,
					listErr:  test.listErr,
					claimErr: test.claimErr,
				},
			})
			command.SetArgs([]string{"name", "--format", "json"})
			stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
			command.SetOut(stdout)
			command.SetErr(stderr)

			err := command.Execute()
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			if stdout.Len() != 0 || strings.Contains(stderr.String(), agentNameFallbackWarning) {
				t.Fatalf("stdout = %q, stderr = %q", stdout, stderr)
			}
		})
	}
}

func TestAgentNameRejectsMalformedClaimResponse(t *testing.T) {
	registry := &automaticNameRegistry{
		catalog:            automaticNameCatalog("Athena"),
		emptyClaimResponse: true,
	}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         registry,
		RandomIndex:      func(int) int { return 0 },
	})
	command.SetArgs([]string{"name", "--format", "json"})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "incompatible") {
		t.Fatalf("error = %v", err)
	}
	if stdout.Len() != 0 || strings.Contains(stderr.String(), agentNameFallbackWarning) {
		t.Fatalf("stdout = %q, stderr = %q", stdout, stderr)
	}
}

func TestAgentNameReusesStoredFallbackWhileOffline(t *testing.T) {
	store := &capturingAgentProfileStore{
		saved: projectchat.AgentProfile{DisplayName: "Selria-7KQ4NP"},
	}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		ProfileStore:     store,
		Registry:         &automaticNameRegistry{listErr: projectchat.ErrUnavailable},
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

func TestAgentNameFallbackRetriesVisibleCollision(t *testing.T) {
	names := []string{"Mira", "Wenren-9R4K2P"}
	command := newAgentCommand(agentNameDependencies{
		IdentityProvider: fixedThreadIdentityProvider(chatTestThreadID),
		Registry:         &automaticNameRegistry{listErr: projectchat.ErrUnavailable},
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

func TestDefaultAgentNameRuntimeReportsMissingMachineCredential(t *testing.T) {
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

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "project connect") {
		t.Fatalf("error = %v", err)
	}
	if stdout.Len() != 0 || strings.Contains(stderr.String(), agentNameFallbackWarning) {
		t.Fatalf("stdout = %q, stderr = %q", stdout, stderr)
	}
}

func TestGeneratedFallbackNameIsCompactAndStableShape(t *testing.T) {
	if name := generateFallbackAgentName(func(int) int { return 0 }); name != "Aebaden-222222" {
		t.Fatalf("name = %q", name)
	}
}

func TestAutomaticAgentNameSpaceExceedsPreviousFallbackLimitWithoutDuplicates(t *testing.T) {
	if automaticAgentNamePoolSize() <= 1024 {
		t.Fatalf("automatic name pool = %d", automaticAgentNamePoolSize())
	}
	names := make(map[string]struct{}, automaticAgentNamePoolSize())
	for attempt := range automaticAgentNamePoolSize() {
		name := automaticAgentNameForThread(chatTestThreadID, attempt)
		if _, found := names[name]; found {
			t.Fatalf("duplicate automatic name %q at attempt %d", name, attempt)
		}
		names[name] = struct{}{}
	}
}

func TestLocalAgentNameExhaustionReturnsAPreciseErrorWithoutMachineCode(t *testing.T) {
	name, err := uniqueFallbackAgentName(
		chatTestThreadID,
		normalizedAgentNames([]string{"Aebaden"}),
		func(string, int) string { return "Aebaden" },
	)
	if name != "" || !errors.Is(err, errLocalAgentNamePoolExhausted) {
		t.Fatalf("name = %q, error = %v", name, err)
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

func fixedThreadIdentityProvider(threadID string) projectchat.ThreadIdentityProvider {
	return projectchat.ThreadIdentityProviderFunc(func(context.Context) (string, error) {
		return threadID, nil
	})
}

type automaticNameRegistry struct {
	catalog             projectchat.NameCatalog
	listErr             error
	claimErr            error
	claimErrs           map[string]error
	claimed             []string
	waitForCancellation bool
	emptyClaimResponse  bool
	automaticClaimCalls int
	automaticExcluded   []string
	automaticPreferred  string
}

func (registry *automaticNameRegistry) ClaimAutomaticName(
	_ context.Context,
	threadID string,
	excludedNames []string,
	preferredName string,
) (projectchat.NameClaim, error) {
	registry.automaticClaimCalls++
	registry.automaticExcluded = append([]string(nil), excludedNames...)
	registry.automaticPreferred = preferredName
	if registry.claimErr != nil {
		return projectchat.NameClaim{}, registry.claimErr
	}
	if registry.emptyClaimResponse {
		return projectchat.NameClaim{}, nil
	}
	name := preferredName
	if name == "" {
		name = automaticAgentNameForThread(threadID, 0)
	}
	return projectchat.NameClaim{
		Name: name, DisplayName: name, Category: projectchat.NameCategoryMythology,
		ThreadID: threadID,
	}, nil
}

func (registry *automaticNameRegistry) ListNames(
	ctx context.Context,
	_ string,
) (projectchat.NameCatalog, error) {
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
	if registry.claimErr != nil {
		return projectchat.NameClaim{}, registry.claimErr
	}
	if registry.emptyClaimResponse {
		return projectchat.NameClaim{}, nil
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
