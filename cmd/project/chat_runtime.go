package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/DotNaos/project-space/internal/projectchat"
	"github.com/spf13/cobra"
)

const (
	chatConnectorConfigEnvironment          = "PROJECT_CONNECTOR_CONFIG"
	chatConnectorTokenEnvironment           = "PROJECT_CONNECTOR_REGISTRATION_TOKEN"
	chatConnectorTokenFileEnvironment       = "PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE"
	maxChatConnectorConfigBytes       int64 = 64 * 1024
	maxChatCredentialBytes            int64 = 16 * 1024
)

type chatRuntimeDependencies struct {
	LookupEnv     func(string) (string, bool)
	UserConfigDir func() (string, error)
	UserHomeDir   func() (string, error)
	NewClient     func(projectchat.Config) (projectchat.ClientAPI, error)
}

type chatConnectorRuntimeConfig struct {
	MachineID             string                    `json:"machineId"`
	RegistrationTokenFile string                    `json:"registrationTokenFile,omitempty"`
	Hubs                  []chatConnectorRuntimeHub `json:"hubs"`
}

type chatConnectorRuntimeHub struct {
	Name                  string `json:"name"`
	URL                   string `json:"url"`
	RegistrationTokenFile string `json:"registrationTokenFile,omitempty"`
	Disabled              bool   `json:"disabled,omitempty"`
}

type chatConnectorSelection struct {
	BaseURL             string
	MachineID           string
	RegistrationFile    string
	ConnectorConfigPath string
}

type lazyProjectChatClient struct {
	load   func() (projectchat.ClientAPI, error)
	once   sync.Once
	client projectchat.ClientAPI
	err    error
}

func newDefaultChatCommand() *cobra.Command {
	return newDefaultChatCommandWithRuntime(chatRuntimeDependencies{})
}

func newDefaultChatCommandWithRuntime(dependencies chatRuntimeDependencies) *cobra.Command {
	dependencies = normalizeChatRuntimeDependencies(dependencies)
	client := &lazyProjectChatClient{
		load: func() (projectchat.ClientAPI, error) {
			return loadProjectChatRuntimeClient(dependencies)
		},
	}
	return newChatCommand(chatCommandDependencies{
		IdentityProvider: projectchat.EnvironmentThreadIdentityProvider{
			LookupEnv: dependencies.LookupEnv,
		},
		ProfileProvider: projectchat.EnvironmentAgentProfileProvider{
			LookupEnv: dependencies.LookupEnv,
		},
		Client: client,
	})
}

func normalizeChatRuntimeDependencies(dependencies chatRuntimeDependencies) chatRuntimeDependencies {
	if dependencies.LookupEnv == nil {
		dependencies.LookupEnv = os.LookupEnv
	}
	if dependencies.UserConfigDir == nil {
		dependencies.UserConfigDir = os.UserConfigDir
	}
	if dependencies.UserHomeDir == nil {
		dependencies.UserHomeDir = os.UserHomeDir
	}
	if dependencies.NewClient == nil {
		dependencies.NewClient = func(config projectchat.Config) (projectchat.ClientAPI, error) {
			return projectchat.NewClient(config)
		}
	}
	return dependencies
}

func loadProjectChatRuntimeClient(dependencies chatRuntimeDependencies) (projectchat.ClientAPI, error) {
	selection, err := loadChatConnectorSelection(dependencies)
	if err != nil {
		return nil, err
	}
	credentials := projectchat.CredentialProviderFunc(func(context.Context) (string, error) {
		return loadChatConnectorCredential(selection, dependencies)
	})
	return dependencies.NewClient(projectchat.Config{
		BaseURL:            selection.BaseURL,
		CredentialProvider: credentials,
		MachineID:          selection.MachineID,
	})
}

func loadChatConnectorSelection(dependencies chatRuntimeDependencies) (chatConnectorSelection, error) {
	configPath, err := chatConnectorRuntimeConfigPath(dependencies)
	if err != nil {
		return chatConnectorSelection{}, projectchat.ErrMissingMachineID
	}
	config, err := readChatConnectorRuntimeConfig(configPath)
	if err != nil {
		return chatConnectorSelection{}, projectchat.ErrMissingMachineID
	}
	machineID := strings.TrimSpace(config.MachineID)
	if machineID == "" {
		return chatConnectorSelection{}, projectchat.ErrMissingMachineID
	}
	if machineID != config.MachineID {
		return chatConnectorSelection{}, projectchat.ErrInvalidMachineID
	}
	hub, found := selectChatConnectorHub(config.Hubs)
	if !found {
		return chatConnectorSelection{}, projectchat.ErrInvalidBaseURL
	}
	registrationFile := strings.TrimSpace(hub.RegistrationTokenFile)
	if registrationFile == "" {
		registrationFile = strings.TrimSpace(config.RegistrationTokenFile)
	}
	return chatConnectorSelection{
		BaseURL:             strings.TrimRight(strings.TrimSpace(hub.URL), "/"),
		MachineID:           machineID,
		RegistrationFile:    registrationFile,
		ConnectorConfigPath: configPath,
	}, nil
}

func chatConnectorRuntimeConfigPath(dependencies chatRuntimeDependencies) (string, error) {
	if configured, found := dependencies.LookupEnv(chatConnectorConfigEnvironment); found && strings.TrimSpace(configured) != "" {
		return filepath.Abs(strings.TrimSpace(configured))
	}
	configDirectory, err := dependencies.UserConfigDir()
	if err != nil || strings.TrimSpace(configDirectory) == "" {
		return "", projectchat.ErrMissingMachineID
	}
	return filepath.Join(configDirectory, "project-space", "connector.json"), nil
}

func readChatConnectorRuntimeConfig(path string) (chatConnectorRuntimeConfig, error) {
	file, err := os.Open(path)
	if err != nil {
		return chatConnectorRuntimeConfig{}, projectchat.ErrMissingMachineID
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maxChatConnectorConfigBytes+1))
	if err != nil || int64(len(body)) > maxChatConnectorConfigBytes {
		return chatConnectorRuntimeConfig{}, projectchat.ErrMissingMachineID
	}
	config := chatConnectorRuntimeConfig{}
	if json.Unmarshal(body, &config) != nil {
		return chatConnectorRuntimeConfig{}, projectchat.ErrMissingMachineID
	}
	return config, nil
}

func selectChatConnectorHub(hubs []chatConnectorRuntimeHub) (chatConnectorRuntimeHub, bool) {
	bestPriority := 4
	selected := chatConnectorRuntimeHub{}
	for _, hub := range hubs {
		if hub.Disabled {
			continue
		}
		parsed, err := url.Parse(strings.TrimSpace(hub.URL))
		if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			continue
		}
		name := strings.TrimSpace(hub.Name)
		priority := 4
		switch {
		case parsed.Scheme == "https" && strings.EqualFold(name, "prod"):
			priority = 0
		case parsed.Scheme == "https":
			priority = 1
		case parsed.Scheme == "http" && strings.EqualFold(name, "dev") && isChatLoopbackHost(parsed.Hostname()):
			priority = 2
		}
		if priority < bestPriority {
			bestPriority = priority
			selected = hub
		}
	}
	return selected, bestPriority < 4
}

func isChatLoopbackHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "localhost" {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func loadChatConnectorCredential(
	selection chatConnectorSelection,
	dependencies chatRuntimeDependencies,
) (string, error) {
	if token, found := dependencies.LookupEnv(chatConnectorTokenEnvironment); found {
		return validateChatConnectorCredential(token)
	}
	credentialPath := ""
	if configured, found := dependencies.LookupEnv(chatConnectorTokenFileEnvironment); found {
		credentialPath = strings.TrimSpace(configured)
	}
	if credentialPath == "" {
		credentialPath = selection.RegistrationFile
	}
	if credentialPath == "" {
		return "", projectchat.ErrMissingCredential
	}
	resolvedPath, err := resolveChatCredentialPath(
		credentialPath,
		selection.ConnectorConfigPath,
		dependencies.UserHomeDir,
	)
	if err != nil {
		return "", projectchat.ErrMissingCredential
	}
	return readPrivateChatCredential(resolvedPath)
}

func resolveChatCredentialPath(path string, configPath string, userHomeDir func() (string, error)) (string, error) {
	trimmed := strings.TrimSpace(path)
	if strings.HasPrefix(trimmed, "~/") {
		home, err := userHomeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return "", projectchat.ErrMissingCredential
		}
		trimmed = filepath.Join(home, strings.TrimPrefix(trimmed, "~/"))
	}
	if filepath.IsAbs(trimmed) {
		return filepath.Clean(trimmed), nil
	}
	return filepath.Clean(filepath.Join(filepath.Dir(configPath), trimmed)), nil
}

func readPrivateChatCredential(path string) (string, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode().Perm()&0o077 != 0 || before.Size() > maxChatCredentialBytes {
		return "", projectchat.ErrMissingCredential
	}
	file, err := os.Open(path)
	if err != nil {
		return "", projectchat.ErrMissingCredential
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || !after.Mode().IsRegular() || after.Mode().Perm()&0o077 != 0 {
		return "", projectchat.ErrMissingCredential
	}
	body, err := io.ReadAll(io.LimitReader(file, maxChatCredentialBytes+1))
	if err != nil || int64(len(body)) > maxChatCredentialBytes {
		return "", projectchat.ErrMissingCredential
	}
	token := string(body)
	if strings.HasSuffix(token, "\n") {
		token = strings.TrimSuffix(token, "\n")
		token = strings.TrimSuffix(token, "\r")
	}
	return validateChatConnectorCredential(token)
}

func validateChatConnectorCredential(token string) (string, error) {
	if token == "" || int64(len(token)) > maxChatCredentialBytes || strings.TrimSpace(token) != token {
		return "", projectchat.ErrMissingCredential
	}
	for _, character := range token {
		if character < 0x21 || character > 0x7e {
			return "", projectchat.ErrMissingCredential
		}
	}
	return token, nil
}

func (client *lazyProjectChatClient) projectChatClient() (projectchat.ClientAPI, error) {
	client.once.Do(func() {
		if client.load == nil {
			client.err = projectchat.ErrUnavailable
			return
		}
		client.client, client.err = client.load()
		if client.err == nil && client.client == nil {
			client.err = projectchat.ErrUnavailable
		}
	})
	return client.client, client.err
}

func (client *lazyProjectChatClient) Join(ctx context.Context, threadID string, profile projectchat.AgentProfile) error {
	loaded, err := client.projectChatClient()
	if err != nil {
		return err
	}
	return loaded.Join(ctx, threadID, profile)
}

func (client *lazyProjectChatClient) UpdatePresence(ctx context.Context, threadID string, profile projectchat.AgentProfile) error {
	loaded, err := client.projectChatClient()
	if err != nil {
		return err
	}
	return loaded.UpdatePresence(ctx, threadID, profile)
}

func (client *lazyProjectChatClient) Send(ctx context.Context, threadID string, channelID string, body string, key string) (projectchat.Message, error) {
	loaded, err := client.projectChatClient()
	if err != nil {
		return projectchat.Message{}, err
	}
	return loaded.Send(ctx, threadID, channelID, body, key)
}

func (client *lazyProjectChatClient) Read(ctx context.Context, threadID string, channelID string, limit int) (projectchat.ReadResult, error) {
	loaded, err := client.projectChatClient()
	if err != nil {
		return projectchat.ReadResult{}, err
	}
	return loaded.Read(ctx, threadID, channelID, limit)
}

func (client *lazyProjectChatClient) Acknowledge(ctx context.Context, threadID string, channelID string, sequence uint64) error {
	loaded, err := client.projectChatClient()
	if err != nil {
		return err
	}
	return loaded.Acknowledge(ctx, threadID, channelID, sequence)
}
