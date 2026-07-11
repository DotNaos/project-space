package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/projectchat"
)

const (
	legacyChatConnectorConfigEnvironment    = "PROJECT_CONNECTOR_CONFIG"
	legacyChatConnectorTokenEnvironment     = "PROJECT_CONNECTOR_REGISTRATION_TOKEN"
	legacyChatConnectorTokenFileEnvironment = "PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE"
)

func TestDefaultChatCommandLoadsMachineCredentialLazily(t *testing.T) {
	var environmentLookups int
	var storeCreations int
	var clientCreations int
	command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: func(string) (string, bool) {
			environmentLookups++
			return "", false
		},
		NewCredentialStore: func() (machineconnect.CredentialStore, error) {
			storeCreations++
			return &chatRuntimeCredentialStore{}, nil
		},
		NewClient: func(projectchat.Config) (projectchat.ClientAPI, error) {
			clientCreations++
			return &fakeProjectChatClient{}, nil
		},
	})
	command.SetArgs([]string{"--help"})
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatalf("Execute() error: %v", err)
	}
	if environmentLookups != 0 || storeCreations != 0 || clientCreations != 0 {
		t.Fatalf(
			"help loaded runtime dependencies: environment=%d store=%d client=%d",
			environmentLookups,
			storeCreations,
			clientCreations,
		)
	}
}

func TestChatRuntimeUsesMachineCredentialSnapshotAndEnvironmentIdentity(t *testing.T) {
	store := &chatRuntimeCredentialStore{
		credential: machineconnect.Credential{
			BackendURL: "https://projects.example",
			MachineID:  "machine-secure-1",
			Token:      "machine-token-v1",
		},
	}
	client := &chatRuntimeRecordingClient{}
	var captured projectchat.Config
	var storeCreations int
	var clientCreations int
	command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: chatRuntimeEnvironment(map[string]string{
			"CODEX_THREAD_ID":  chatTestThreadID,
			"CODEX_AGENT_NAME": "Mira",
			"CODEX_TASK_TITLE": "Project Chat Identity",
		}),
		NewCredentialStore: func() (machineconnect.CredentialStore, error) {
			storeCreations++
			return store, nil
		},
		NewClient: func(config projectchat.Config) (projectchat.ClientAPI, error) {
			clientCreations++
			captured = config
			return client, nil
		},
	})
	command.SetArgs([]string{"send", "hello"})
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatalf("Execute() error: %v", err)
	}
	if storeCreations != 1 || store.loadCalls != 1 || clientCreations != 1 {
		t.Fatalf(
			"runtime loads = store %d, credential %d, client %d; want one each",
			storeCreations,
			store.loadCalls,
			clientCreations,
		)
	}
	if captured.BaseURL != "https://projects.example" || captured.MachineID != "machine-secure-1" {
		t.Fatalf("client identity = URL %q machine %q", captured.BaseURL, captured.MachineID)
	}
	if captured.CredentialProvider == nil {
		t.Fatal("runtime client has no credential provider")
	}
	token, err := captured.CredentialProvider.AccessToken(context.Background())
	if err != nil || token != "machine-token-v1" {
		t.Fatalf("credential snapshot = %q, %v", token, err)
	}

	store.credential = machineconnect.Credential{
		BackendURL: "https://changed.example",
		MachineID:  "machine-changed",
		Token:      "machine-token-v2",
	}
	token, err = captured.CredentialProvider.AccessToken(context.Background())
	if err != nil || token != "machine-token-v1" {
		t.Fatalf("credential provider reloaded mutable store state: %q, %v", token, err)
	}
	if captured.BaseURL != "https://projects.example" || captured.MachineID != "machine-secure-1" || store.loadCalls != 1 {
		t.Fatalf("client identity changed after store mutation: %#v, loads=%d", captured, store.loadCalls)
	}

	if client.presenceThreadID != chatTestThreadID || client.sendThreadID != chatTestThreadID {
		t.Fatalf("environment thread identity = presence %q send %q", client.presenceThreadID, client.sendThreadID)
	}
	if client.presenceProfile.DisplayName != "Mira" || client.presenceProfile.TaskTitle != "Project Chat Identity" {
		t.Fatalf("environment agent profile = %#v", client.presenceProfile)
	}
}

func TestChatRuntimeIgnoresLegacyConnectorEnvironment(t *testing.T) {
	values := map[string]string{
		"CODEX_THREAD_ID":                       chatTestThreadID,
		"CODEX_AGENT_NAME":                      "Mira",
		"CODEX_TASK_TITLE":                      "Project Chat",
		legacyChatConnectorConfigEnvironment:    "/tmp/legacy-connector.json",
		legacyChatConnectorTokenEnvironment:     "legacy-shared-token",
		legacyChatConnectorTokenFileEnvironment: "/tmp/legacy-connector.token",
	}
	lookups := map[string]int{}
	lookupEnvironment := func(name string) (string, bool) {
		lookups[name]++
		value, found := values[name]
		return value, found
	}
	store := &chatRuntimeCredentialStore{
		credential: machineconnect.Credential{
			BackendURL: "https://secure.example",
			MachineID:  "machine-secure",
			Token:      "secure-machine-token",
		},
	}
	var captured projectchat.Config
	command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv:          lookupEnvironment,
		NewCredentialStore: func() (machineconnect.CredentialStore, error) { return store, nil },
		NewClient: func(config projectchat.Config) (projectchat.ClientAPI, error) {
			captured = config
			return &chatRuntimeRecordingClient{}, nil
		},
	})
	command.SetArgs([]string{"send", "hello"})
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatalf("Execute() error: %v", err)
	}
	for _, legacyName := range []string{
		legacyChatConnectorConfigEnvironment,
		legacyChatConnectorTokenEnvironment,
		legacyChatConnectorTokenFileEnvironment,
	} {
		if lookups[legacyName] != 0 {
			t.Fatalf("legacy environment %s was read %d times", legacyName, lookups[legacyName])
		}
	}
	token, err := captured.CredentialProvider.AccessToken(context.Background())
	if err != nil || token != "secure-machine-token" {
		t.Fatalf("credential = %q, %v; want secure machine credential", token, err)
	}
	if captured.BaseURL != "https://secure.example" || captured.MachineID != "machine-secure" {
		t.Fatalf("client used legacy connector identity: %#v", captured)
	}
}

func TestChatRuntimeDoesNotFallbackToLegacySharedToken(t *testing.T) {
	store := &chatRuntimeCredentialStore{loadErr: machineconnect.ErrCredentialNotFound}
	var clientCreations int
	command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: chatRuntimeEnvironment(map[string]string{
			"CODEX_THREAD_ID":                       chatTestThreadID,
			"CODEX_AGENT_NAME":                      "Mira",
			legacyChatConnectorConfigEnvironment:    "/tmp/valid-legacy-connector.json",
			legacyChatConnectorTokenEnvironment:     "valid-legacy-shared-token",
			legacyChatConnectorTokenFileEnvironment: "/tmp/valid-legacy-connector.token",
		}),
		NewCredentialStore: func() (machineconnect.CredentialStore, error) { return store, nil },
		NewClient: func(projectchat.Config) (projectchat.ClientAPI, error) {
			clientCreations++
			return &chatRuntimeRecordingClient{}, nil
		},
	})
	command.SetArgs([]string{"send", "hello"})
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})

	err := command.Execute()
	if !errors.Is(err, projectchat.ErrMissingCredential) {
		t.Fatalf("Execute() error = %v, want missing secure machine credential", err)
	}
	if store.loadCalls != 1 || clientCreations != 0 {
		t.Fatalf("fallback path reached client: loads=%d clients=%d", store.loadCalls, clientCreations)
	}
}

func TestChatRuntimeCredentialErrorsDoNotLeak(t *testing.T) {
	const secret = "machine-secret-do-not-print"
	tests := []struct {
		name     string
		newStore func() (machineconnect.CredentialStore, error)
		wantErr  error
	}{
		{
			name: "open secure store",
			newStore: func() (machineconnect.CredentialStore, error) {
				return nil, errors.New("open secure store for " + secret)
			},
			wantErr: projectchat.ErrMissingCredential,
		},
		{
			name: "load secure store",
			newStore: func() (machineconnect.CredentialStore, error) {
				return &chatRuntimeCredentialStore{loadErr: errors.New("decode " + secret)}, nil
			},
			wantErr: projectchat.ErrMissingCredential,
		},
		{
			name: "invalid stored token",
			newStore: func() (machineconnect.CredentialStore, error) {
				return &chatRuntimeCredentialStore{credential: machineconnect.Credential{
					BackendURL: "https://projects.example",
					MachineID:  "machine-1",
					Token:      secret + "\n",
				}}, nil
			},
			wantErr: projectchat.ErrInvalidCredential,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stdout := &bytes.Buffer{}
			stderr := &bytes.Buffer{}
			command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
				LookupEnv: chatRuntimeEnvironment(map[string]string{
					"CODEX_THREAD_ID":                   chatTestThreadID,
					"CODEX_AGENT_NAME":                  "Mira",
					legacyChatConnectorTokenEnvironment: secret,
				}),
				NewCredentialStore: test.newStore,
			})
			command.SetArgs([]string{"send", "hello"})
			command.SetOut(stdout)
			command.SetErr(stderr)

			err := command.Execute()
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("Execute() error = %v, want %v", err, test.wantErr)
			}
			combined := err.Error() + stdout.String() + stderr.String()
			if strings.Contains(combined, secret) {
				t.Fatalf("credential leaked through command result: %q", combined)
			}
		})
	}
}

func TestDefaultChatCommandValidatesEnvironmentIdentityBeforeLoadingCredential(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr error
	}{
		{
			name:    "missing thread",
			env:     map[string]string{"CODEX_AGENT_NAME": "Mira"},
			wantErr: projectchat.ErrMissingThreadID,
		},
		{
			name:    "missing agent name",
			env:     map[string]string{"CODEX_THREAD_ID": chatTestThreadID},
			wantErr: projectchat.ErrMissingAgentName,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var storeCreations int
			command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
				LookupEnv: chatRuntimeEnvironment(test.env),
				NewCredentialStore: func() (machineconnect.CredentialStore, error) {
					storeCreations++
					return &chatRuntimeCredentialStore{}, nil
				},
			})
			command.SetArgs([]string{"send", "hello"})
			command.SetOut(&bytes.Buffer{})
			command.SetErr(&bytes.Buffer{})

			err := command.Execute()
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("Execute() error = %v, want %v", err, test.wantErr)
			}
			if storeCreations != 0 {
				t.Fatalf("credential store opened before environment identity validation: %d", storeCreations)
			}
		})
	}
}

func TestChatRuntimeEndToEndAgainstProjectChatServer(t *testing.T) {
	credentialPath := os.Getenv("PROJECT_CHAT_E2E_CREDENTIAL_FILE")
	if credentialPath == "" {
		t.Skip("PROJECT_CHAT_E2E_CREDENTIAL_FILE is required")
	}
	credential := readProjectChatE2ECredential(t, credentialPath)

	stdout := &bytes.Buffer{}
	command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: chatRuntimeEnvironment(map[string]string{
			"CODEX_THREAD_ID":  "019f503f-f91d-72e3-a8fb-86f167209b9f",
			"CODEX_AGENT_NAME": "Mira",
			"CODEX_TASK_TITLE": "Project Chat identity E2E",
		}),
		NewCredentialStore: func() (machineconnect.CredentialStore, error) {
			return &chatRuntimeCredentialStore{credential: machineconnect.Credential{
				BackendURL:  credential.BackendURL,
				MachineID:   credential.MachineID,
				MachineName: credential.MachineName,
				Token:       credential.Credential,
			}}, nil
		},
	})
	command.SetArgs([]string{"send", "Agent identity E2E: trusted machine credential path."})
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatalf("Execute() error: %v", err)
	}
	if stdout.String() != "Message sent to #general.\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

type projectChatE2ECredential struct {
	BackendURL  string `json:"backendUrl"`
	Credential  string `json:"credential"`
	IssuedAt    string `json:"issuedAt"`
	MachineID   string `json:"machineId"`
	MachineName string `json:"machineName"`
	Version     string `json:"version"`
}

func readProjectChatE2ECredential(t *testing.T, path string) projectChatE2ECredential {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal("open private E2E machine credential")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		t.Fatal("private E2E machine credential has unsafe permissions")
	}
	body, err := io.ReadAll(io.LimitReader(file, 4_097))
	if err != nil || len(body) > 4_096 {
		t.Fatal("read private E2E machine credential")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	credential := projectChatE2ECredential{}
	if err := decoder.Decode(&credential); err != nil {
		t.Fatal("decode private E2E machine credential")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatal("private E2E machine credential has trailing data")
	}
	if credential.Version != "project-space.project-chat-e2e-credential/v1" ||
		credential.BackendURL == "" || credential.Credential == "" ||
		credential.IssuedAt == "" || credential.MachineID == "" ||
		credential.MachineName == "" {
		t.Fatal("private E2E machine credential is incomplete")
	}
	return credential
}

type chatRuntimeCredentialStore struct {
	credential machineconnect.Credential
	loadCalls  int
	loadErr    error
}

func (store *chatRuntimeCredentialStore) LoadKey() (machineconnect.MachineKey, error) {
	return machineconnect.MachineKey{}, machineconnect.ErrMachineKeyNotFound
}

func (store *chatRuntimeCredentialStore) SaveKey(machineconnect.MachineKey) error {
	return nil
}

func (store *chatRuntimeCredentialStore) Load() (machineconnect.Credential, error) {
	store.loadCalls++
	return store.credential, store.loadErr
}

func (store *chatRuntimeCredentialStore) Save(credential machineconnect.Credential) error {
	store.credential = credential
	return nil
}

func (store *chatRuntimeCredentialStore) Delete() error {
	store.credential = machineconnect.Credential{}
	return nil
}

type chatRuntimeRecordingClient struct {
	presenceThreadID string
	presenceProfile  projectchat.AgentProfile
	sendThreadID     string
}

func (client *chatRuntimeRecordingClient) Join(
	_ context.Context,
	threadID string,
	profile projectchat.AgentProfile,
) error {
	client.presenceThreadID = threadID
	client.presenceProfile = profile
	return nil
}

func (client *chatRuntimeRecordingClient) UpdatePresence(
	_ context.Context,
	threadID string,
	profile projectchat.AgentProfile,
) error {
	client.presenceThreadID = threadID
	client.presenceProfile = profile
	return nil
}

func (client *chatRuntimeRecordingClient) Send(
	_ context.Context,
	threadID string,
	_ string,
	_ string,
	_ string,
) (projectchat.Message, error) {
	client.sendThreadID = threadID
	return projectchat.Message{}, nil
}

func (*chatRuntimeRecordingClient) Read(
	context.Context,
	string,
	string,
	int,
) (projectchat.ReadResult, error) {
	return projectchat.ReadResult{}, nil
}

func (*chatRuntimeRecordingClient) Acknowledge(context.Context, string, string, uint64) error {
	return nil
}

func chatRuntimeEnvironment(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, found := values[name]
		return value, found
	}
}
