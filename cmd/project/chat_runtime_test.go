package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/DotNaos/project-space/internal/projectchat"
)

func TestDefaultChatCommandLoadsConnectorRuntimeLazily(t *testing.T) {
	var configLookups atomic.Int32
	var clientCreations atomic.Int32
	command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: func(string) (string, bool) { return "", false },
		UserConfigDir: func() (string, error) {
			configLookups.Add(1)
			return "", errors.New("connector is not installed")
		},
		NewClient: func(projectchat.Config) (projectchat.ClientAPI, error) {
			clientCreations.Add(1)
			return &fakeProjectChatClient{}, nil
		},
	})
	command.SetArgs([]string{"--help"})
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatalf("Execute() error: %v", err)
	}
	if configLookups.Load() != 0 || clientCreations.Load() != 0 {
		t.Fatalf("help loaded connector runtime: config=%d client=%d", configLookups.Load(), clientCreations.Load())
	}
}

func TestChatRuntimeUsesConnectorConfigEnvironmentOrDefaultPath(t *testing.T) {
	configDirectory := t.TempDir()
	dependencies := normalizeChatRuntimeDependencies(chatRuntimeDependencies{
		LookupEnv:     chatRuntimeEnvironment(map[string]string{}),
		UserConfigDir: func() (string, error) { return configDirectory, nil },
	})
	path, err := chatConnectorRuntimeConfigPath(dependencies)
	if err != nil {
		t.Fatalf("chatConnectorRuntimeConfigPath() error: %v", err)
	}
	want := filepath.Join(configDirectory, "project-space", "connector.json")
	if path != want {
		t.Fatalf("config path = %q, want %q", path, want)
	}

	override := filepath.Join(t.TempDir(), "custom-connector.json")
	dependencies.LookupEnv = chatRuntimeEnvironment(map[string]string{chatConnectorConfigEnvironment: override})
	path, err = chatConnectorRuntimeConfigPath(dependencies)
	if err != nil || path != override {
		t.Fatalf("override config path = %q, %v", path, err)
	}
}

func TestChatRuntimeSelectsEnabledProdHub(t *testing.T) {
	configPath := writeChatRuntimeConfig(t, chatConnectorRuntimeConfig{
		MachineID: "machine-prod-1",
		Hubs: []chatConnectorRuntimeHub{
			{Name: "prod", URL: "https://disabled.example", Disabled: true},
			{Name: "dev", URL: "http://127.0.0.1:5177"},
			{Name: "backup", URL: "https://backup.example"},
			{Name: "prod", URL: "https://projects.example", RegistrationTokenFile: "connector.token"},
		},
	})
	environment := chatRuntimeEnvironment(map[string]string{
		chatConnectorConfigEnvironment: configPath,
		"CODEX_THREAD_ID":              chatTestThreadID,
		"CODEX_AGENT_NAME":             "Mira",
		"CODEX_TASK_TITLE":             "Project Chat",
	})
	var captured projectchat.Config
	client := &fakeProjectChatClient{}
	command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: environment,
		NewClient: func(config projectchat.Config) (projectchat.ClientAPI, error) {
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
	if captured.BaseURL != "https://projects.example" || captured.MachineID != "machine-prod-1" {
		t.Fatalf("selected runtime = %#v", captured)
	}
	if captured.CredentialProvider == nil {
		t.Fatal("runtime client has no lazy credential provider")
	}
	if len(client.sentMessages()) != 1 {
		t.Fatalf("send calls = %d, want 1", len(client.sentMessages()))
	}
}

func TestChatRuntimeAllowsOnlyExplicitLoopbackDevHTTP(t *testing.T) {
	tests := []struct {
		name    string
		hub     chatConnectorRuntimeHub
		wantURL string
		wantErr error
	}{
		{name: "configured loopback dev", hub: chatConnectorRuntimeHub{Name: "dev", URL: "http://localhost:5177"}, wantURL: "http://localhost:5177"},
		{name: "loopback prod", hub: chatConnectorRuntimeHub{Name: "prod", URL: "http://127.0.0.1:5177"}, wantErr: projectchat.ErrInvalidBaseURL},
		{name: "remote dev", hub: chatConnectorRuntimeHub{Name: "dev", URL: "http://project-chat.example"}, wantErr: projectchat.ErrInvalidBaseURL},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configPath := writeChatRuntimeConfig(t, chatConnectorRuntimeConfig{
				MachineID: "machine-dev-1",
				Hubs:      []chatConnectorRuntimeHub{test.hub},
			})
			dependencies := normalizeChatRuntimeDependencies(chatRuntimeDependencies{
				LookupEnv: chatRuntimeEnvironment(map[string]string{chatConnectorConfigEnvironment: configPath}),
				NewClient: func(config projectchat.Config) (projectchat.ClientAPI, error) {
					if config.BaseURL != test.wantURL {
						t.Fatalf("BaseURL = %q, want %q", config.BaseURL, test.wantURL)
					}
					return &fakeProjectChatClient{}, nil
				},
			})
			_, err := loadProjectChatRuntimeClient(dependencies)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("loadProjectChatRuntimeClient() error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

func TestReadPrivateChatCredentialRejectsUnsafeFiles(t *testing.T) {
	t.Run("private regular file", func(t *testing.T) {
		path := writeChatRuntimeToken(t, "private-token\n", 0o600)
		token, err := readPrivateChatCredential(path)
		if err != nil || token != "private-token" {
			t.Fatalf("readPrivateChatCredential() = %q, %v", token, err)
		}
	})

	tests := []struct {
		name    string
		content string
		mode    os.FileMode
		link    bool
	}{
		{name: "world readable", content: "world-readable", mode: 0o644},
		{name: "terminal controls", content: "secret\x1b[31m", mode: 0o600},
		{name: "surrounding whitespace", content: " secret ", mode: 0o600},
		{name: "multiple line endings", content: "secret\n\n", mode: 0o600},
		{name: "non ascii", content: "secrét", mode: 0o600},
		{name: "oversized", content: strings.Repeat("x", int(maxChatCredentialBytes)+1), mode: 0o600},
		{name: "symlink", content: "linked-secret", mode: 0o600, link: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeChatRuntimeToken(t, test.content, test.mode)
			if test.link {
				link := filepath.Join(t.TempDir(), "connector-token-link")
				if err := os.Symlink(path, link); err != nil {
					t.Fatalf("Symlink() error: %v", err)
				}
				path = link
			}
			token, err := readPrivateChatCredential(path)
			if !errors.Is(err, projectchat.ErrMissingCredential) || token != "" {
				t.Fatalf("readPrivateChatCredential() = %q, %v", token, err)
			}
			if strings.Contains(err.Error(), test.content) {
				t.Fatal("credential leaked through error")
			}
		})
	}
}

func TestChatRuntimeCredentialUsesOnlyDocumentedOverrides(t *testing.T) {
	configDirectory := t.TempDir()
	configPath := filepath.Join(configDirectory, "connector.json")
	configuredToken := writeChatRuntimeToken(t, "configured-token", 0o600)
	overrideToken := writeChatRuntimeToken(t, "file-override-token", 0o600)
	relativeToken := filepath.Join(configDirectory, "relative.token")
	if err := os.WriteFile(relativeToken, []byte("relative-token\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error: %v", err)
	}
	if err := os.Chmod(relativeToken, 0o600); err != nil {
		t.Fatalf("Chmod() error: %v", err)
	}
	selection := chatConnectorSelection{
		ConnectorConfigPath: configPath,
		RegistrationFile:    configuredToken,
	}
	tests := []struct {
		name    string
		env     map[string]string
		want    string
		wantErr error
	}{
		{name: "configured file", env: map[string]string{}, want: "configured-token"},
		{name: "token file override", env: map[string]string{chatConnectorTokenFileEnvironment: overrideToken}, want: "file-override-token"},
		{name: "inline override", env: map[string]string{chatConnectorTokenEnvironment: "inline-token", chatConnectorTokenFileEnvironment: overrideToken}, want: "inline-token"},
		{name: "unrecognized named token is ignored", env: map[string]string{"PROJECT_CONNECTOR_PROD_REGISTRATION_TOKEN": "other-token"}, want: "configured-token"},
		{name: "unsafe inline token", env: map[string]string{chatConnectorTokenEnvironment: "do-not-leak\nsecret"}, wantErr: projectchat.ErrMissingCredential},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dependencies := normalizeChatRuntimeDependencies(chatRuntimeDependencies{LookupEnv: chatRuntimeEnvironment(test.env)})
			token, err := loadChatConnectorCredential(selection, dependencies)
			if !errors.Is(err, test.wantErr) || token != test.want {
				t.Fatalf("loadChatConnectorCredential() = %q, %v", token, err)
			}
			if err != nil && strings.Contains(err.Error(), "do-not-leak") {
				t.Fatal("credential leaked through error")
			}
		})
	}

	selection.RegistrationFile = "relative.token"
	token, err := loadChatConnectorCredential(
		selection,
		normalizeChatRuntimeDependencies(chatRuntimeDependencies{LookupEnv: chatRuntimeEnvironment(nil)}),
	)
	if err != nil || token != "relative-token" {
		t.Fatalf("relative credential = %q, %v", token, err)
	}
}

func TestDefaultChatCommandFailsClosedForMissingIdentityAndConnector(t *testing.T) {
	validConfig := writeChatRuntimeConfig(t, chatConnectorRuntimeConfig{
		MachineID: "machine-1",
		Hubs:      []chatConnectorRuntimeHub{{Name: "prod", URL: "https://projects.example"}},
	})
	tests := []struct {
		name    string
		env     map[string]string
		wantErr error
	}{
		{
			name: "thread",
			env: map[string]string{
				chatConnectorConfigEnvironment: validConfig,
				"CODEX_AGENT_NAME":             "Mira",
			},
			wantErr: projectchat.ErrMissingThreadID,
		},
		{
			name: "agent name",
			env: map[string]string{
				chatConnectorConfigEnvironment: validConfig,
				"CODEX_THREAD_ID":              chatTestThreadID,
			},
			wantErr: projectchat.ErrMissingAgentName,
		},
		{
			name: "machine",
			env: map[string]string{
				chatConnectorConfigEnvironment: writeChatRuntimeConfig(t, chatConnectorRuntimeConfig{Hubs: []chatConnectorRuntimeHub{{Name: "prod", URL: "https://projects.example"}}}),
				"CODEX_THREAD_ID":              chatTestThreadID,
				"CODEX_AGENT_NAME":             "Mira",
			},
			wantErr: projectchat.ErrMissingMachineID,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var clientCreations atomic.Int32
			command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
				LookupEnv: chatRuntimeEnvironment(test.env),
				NewClient: func(projectchat.Config) (projectchat.ClientAPI, error) {
					clientCreations.Add(1)
					return &fakeProjectChatClient{}, nil
				},
			})
			command.SetArgs([]string{"send", "hello"})
			command.SetOut(&bytes.Buffer{})
			command.SetErr(&bytes.Buffer{})
			err := command.Execute()
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("Execute() error = %v, want %v", err, test.wantErr)
			}
			if clientCreations.Load() != 0 {
				t.Fatalf("client creations = %d, want 0", clientCreations.Load())
			}
		})
	}
}

func TestDefaultChatCommandDoesNotLeakRejectedToken(t *testing.T) {
	secret := "private-token-do-not-print\nunsafe"
	configPath := writeChatRuntimeConfig(t, chatConnectorRuntimeConfig{
		MachineID: "machine-1",
		Hubs:      []chatConnectorRuntimeHub{{Name: "prod", URL: "https://projects.example"}},
	})
	command := newDefaultChatCommandWithRuntime(chatRuntimeDependencies{
		LookupEnv: chatRuntimeEnvironment(map[string]string{
			chatConnectorConfigEnvironment: configPath,
			chatConnectorTokenEnvironment:  secret,
			"CODEX_THREAD_ID":              chatTestThreadID,
			"CODEX_AGENT_NAME":             "Mira",
		}),
	})
	command.SetArgs([]string{"send", "hello"})
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})

	err := command.Execute()
	if !errors.Is(err, projectchat.ErrMissingCredential) {
		t.Fatalf("Execute() error = %v, want missing credential", err)
	}
	if strings.Contains(err.Error(), "private-token-do-not-print") {
		t.Fatal("credential leaked through command error")
	}
}

func writeChatRuntimeConfig(t *testing.T, config chatConnectorRuntimeConfig) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, "connector.json")
	body, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("WriteFile() error: %v", err)
	}
	return path
}

func writeChatRuntimeToken(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "connector.token")
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatalf("WriteFile() error: %v", err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("Chmod() error: %v", err)
	}
	return path
}

func chatRuntimeEnvironment(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, found := values[name]
		return value, found
	}
}
