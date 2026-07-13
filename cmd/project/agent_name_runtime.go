package main

import (
	"github.com/DotNaos/project-space/internal/projectchat"
	"github.com/spf13/cobra"
)

func newDefaultAgentCommand() *cobra.Command {
	return newDefaultAgentCommandWithRuntime(chatRuntimeDependencies{})
}

func newDefaultAgentCommandWithRuntime(dependencies chatRuntimeDependencies) *cobra.Command {
	dependencies = normalizeChatRuntimeDependencies(dependencies)
	profileStore, profileStoreErr := dependencies.NewProfileStore()
	client := &lazyProjectChatClient{
		load: func() (projectchat.ClientAPI, error) {
			return loadProjectChatRuntimeClient(dependencies)
		},
	}
	return newAgentCommand(agentNameDependencies{
		IdentityProvider: projectchat.EnvironmentThreadIdentityProvider{
			LookupEnv: dependencies.LookupEnv,
		},
		ProfileStore: profileStoreOrError{store: profileStore, err: profileStoreErr},
		Registry:     client,
	})
}
