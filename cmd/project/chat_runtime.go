package main

import (
	"context"
	"os"
	"sync"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/projectchat"
	"github.com/spf13/cobra"
)

type chatRuntimeDependencies struct {
	LookupEnv          func(string) (string, bool)
	NewCredentialStore func() (machineconnect.CredentialStore, error)
	NewProfileStore    func() (projectchat.AgentProfileStore, error)
	NewClient          func(projectchat.Config) (projectchat.ClientAPI, error)
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
	profileStore, profileStoreErr := dependencies.NewProfileStore()
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
		ProfileStore: profileStoreOrError{store: profileStore, err: profileStoreErr},
		Client:       client,
	})
}

func normalizeChatRuntimeDependencies(dependencies chatRuntimeDependencies) chatRuntimeDependencies {
	if dependencies.LookupEnv == nil {
		dependencies.LookupEnv = os.LookupEnv
	}
	if dependencies.NewCredentialStore == nil {
		dependencies.NewCredentialStore = machineconnect.NewDefaultCredentialStore
	}
	if dependencies.NewProfileStore == nil {
		dependencies.NewProfileStore = func() (projectchat.AgentProfileStore, error) {
			return projectchat.NewDefaultAgentProfileStore()
		}
	}
	if dependencies.NewClient == nil {
		dependencies.NewClient = func(config projectchat.Config) (projectchat.ClientAPI, error) {
			return projectchat.NewClient(config)
		}
	}
	return dependencies
}

type profileStoreOrError struct {
	store projectchat.AgentProfileStore
	err   error
}

func (store profileStoreOrError) Load(threadID string) (projectchat.AgentProfile, error) {
	if store.err != nil || store.store == nil {
		return projectchat.AgentProfile{}, projectchat.ErrUnavailable
	}
	return store.store.Load(threadID)
}

func (store profileStoreOrError) Save(threadID string, profile projectchat.AgentProfile) error {
	if store.err != nil || store.store == nil {
		return projectchat.ErrUnavailable
	}
	return store.store.Save(threadID, profile)
}

func loadProjectChatRuntimeClient(dependencies chatRuntimeDependencies) (projectchat.ClientAPI, error) {
	store, err := dependencies.NewCredentialStore()
	if err != nil || store == nil {
		return nil, projectchat.ErrMissingCredential
	}
	credential, err := store.Load()
	if err != nil {
		return nil, projectchat.ErrMissingCredential
	}
	token := credential.Token
	credentials := projectchat.CredentialProviderFunc(func(context.Context) (string, error) {
		return token, nil
	})
	return dependencies.NewClient(projectchat.Config{
		BaseURL:            credential.BackendURL,
		CredentialProvider: credentials,
		MachineID:          credential.MachineID,
	})
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
