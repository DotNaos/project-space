package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/projectcatalog"
	"github.com/DotNaos/project-space/internal/terminallauncher"
)

const projectCompletionCacheAge = time.Minute
const projectCompletionRequestTimeout = time.Second

type projectCatalogLoad struct {
	Cached  bool
	Catalog projectcatalog.Catalog
}

type projectCatalogLoader func(context.Context, bool) (projectCatalogLoad, error)

type projectCommandsDependencies struct {
	Launcher    terminallauncher.Launcher
	LoadCatalog projectCatalogLoader
}

func defaultProjectCommandsDependencies() projectCommandsDependencies {
	return projectCommandsDependencies{
		Launcher:    terminallauncher.New(),
		LoadCatalog: loadProjectCatalog,
	}
}

func loadProjectCatalog(
	ctx context.Context,
	allowCachedFallback bool,
) (projectCatalogLoad, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return projectCatalogLoad{}, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return projectCatalogLoad{}, errors.New(
			"this machine is not connected to Project Space",
		)
	}
	token := credential.Token
	client, err := projectcatalog.NewClient(projectcatalog.Config{
		BaseURL:         credential.BackendURL,
		CallerMachineID: credential.MachineID,
		CredentialProvider: projectcatalog.CredentialProviderFunc(
			func(context.Context) (string, error) { return token, nil },
		),
	})
	if err != nil {
		return projectCatalogLoad{}, err
	}
	cache := projectcatalog.Cache{Directory: projectCatalogCacheDirectory()}
	key := projectcatalog.CacheKey(credential.BackendURL, credential.MachineID, token)
	requestContext := ctx
	cancel := func() {}
	if allowCachedFallback {
		requestContext, cancel = context.WithTimeout(ctx, projectCompletionRequestTimeout)
	}
	defer cancel()
	catalog, liveErr := client.List(requestContext)
	if liveErr == nil {
		_ = cache.Write(key, catalog)
		return projectCatalogLoad{Catalog: catalog}, nil
	}
	if allowCachedFallback {
		cached, cacheErr := cache.Read(key, projectCompletionCacheAge)
		if cacheErr == nil {
			return projectCatalogLoad{Cached: true, Catalog: cached}, nil
		}
	}
	return projectCatalogLoad{}, liveErr
}

func projectCatalogCacheDirectory() string {
	if override := os.Getenv("PROJECT_CLI_CACHE_DIR"); override != "" {
		return filepath.Clean(override)
	}
	directory, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(directory, "project-space", "cli")
}
