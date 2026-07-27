package main

import (
	"context"
	"errors"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/roadmap"
)

type roadmapCommandRuntime struct {
	client roadmap.API
}

type roadmapCommandDependencies struct {
	LoadRuntime       func(context.Context) (roadmapCommandRuntime, error)
	ResolveRepository func(context.Context) (string, error)
}

func defaultRoadmapCommandDependencies() roadmapCommandDependencies {
	return roadmapCommandDependencies{
		LoadRuntime:       loadRoadmapCommandRuntime,
		ResolveRepository: resolveCurrentGitHubRepository,
	}
}

func loadRoadmapCommandRuntime(_ context.Context) (roadmapCommandRuntime, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return roadmapCommandRuntime{}, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return roadmapCommandRuntime{}, errors.New(
			"this machine is not connected to Project Space",
		)
	}
	token := credential.Token
	client, err := roadmap.NewClient(roadmap.Config{
		BaseURL:         credential.BackendURL,
		CallerMachineID: credential.MachineID,
		CredentialProvider: roadmap.CredentialProviderFunc(
			func(context.Context) (string, error) { return token, nil },
		),
	})
	if err != nil {
		return roadmapCommandRuntime{}, err
	}
	return roadmapCommandRuntime{client: client}, nil
}
