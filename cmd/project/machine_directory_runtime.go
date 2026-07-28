package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/machinedirectory"
)

const machineDirectoryCompletionCacheAge = time.Minute
const machineDirectoryCompletionTimeout = time.Second

type machineDirectoryLoad[T any] struct {
	Cached bool
	Result T
}

type machineDirectoryDependencies struct {
	ListMachines func(context.Context, bool) (machineDirectoryLoad[machinedirectory.MachinesResult], error)
	ListThreads  func(context.Context, machinedirectory.ThreadFilter, bool) (machineDirectoryLoad[machinedirectory.ThreadsResult], error)
	ResolveSSH   func(context.Context, string) (machinedirectory.SSHResult, error)
	RunSSH       func(string) error
}

func defaultMachineDirectoryDependencies() machineDirectoryDependencies {
	dependencies := machineDirectoryDependencies{}
	dependencies.ListMachines = loadMachineDirectoryMachines
	dependencies.ListThreads = loadMachineDirectoryThreads
	dependencies.ResolveSSH = resolveMachineDirectorySSH
	dependencies.RunSSH = runInteractiveSSH
	return dependencies
}

func machineDirectoryClient() (
	*machinedirectory.Client,
	machineconnect.Credential,
	string,
	error,
) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return nil, machineconnect.Credential{}, "", errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return nil, machineconnect.Credential{}, "", errors.New(
			"this machine is not connected to Project Space",
		)
	}
	token := credential.Token
	client, err := machinedirectory.NewClient(machinedirectory.Config{
		BaseURL:         credential.BackendURL,
		CallerMachineID: credential.MachineID,
		CredentialProvider: machinedirectory.CredentialProviderFunc(
			func(context.Context) (string, error) { return token, nil },
		),
	})
	return client, credential, token, err
}

func loadMachineDirectoryMachines(
	ctx context.Context,
	allowCachedFallback bool,
) (machineDirectoryLoad[machinedirectory.MachinesResult], error) {
	client, credential, token, err := machineDirectoryClient()
	if err != nil {
		return machineDirectoryLoad[machinedirectory.MachinesResult]{}, err
	}
	cache := machinedirectory.Cache{Directory: machineDirectoryCacheDirectory()}
	key := machinedirectory.CacheKey(
		credential.BackendURL, credential.MachineID, token, "machines",
	)
	requestContext, cancel := completionContext(ctx, allowCachedFallback)
	defer cancel()
	result, liveErr := client.ListMachines(requestContext)
	if liveErr == nil {
		if allowCachedFallback {
			_ = cache.WriteMachines(key, result)
		}
		return machineDirectoryLoad[machinedirectory.MachinesResult]{Result: result}, nil
	}
	if allowCachedFallback {
		cached, cacheErr := cache.ReadMachines(key, machineDirectoryCompletionCacheAge)
		if cacheErr == nil {
			return machineDirectoryLoad[machinedirectory.MachinesResult]{
				Cached: true, Result: cached,
			}, nil
		}
	}
	return machineDirectoryLoad[machinedirectory.MachinesResult]{}, liveErr
}

func loadMachineDirectoryThreads(
	ctx context.Context,
	filter machinedirectory.ThreadFilter,
	allowCachedFallback bool,
) (machineDirectoryLoad[machinedirectory.ThreadsResult], error) {
	client, credential, token, err := machineDirectoryClient()
	if err != nil {
		return machineDirectoryLoad[machinedirectory.ThreadsResult]{}, err
	}
	encodedFilter, _ := json.Marshal(filter)
	cache := machinedirectory.Cache{Directory: machineDirectoryCacheDirectory()}
	key := machinedirectory.CacheKey(
		credential.BackendURL, credential.MachineID, token,
		"threads:"+string(encodedFilter),
	)
	requestContext, cancel := completionContext(ctx, allowCachedFallback)
	defer cancel()
	result, liveErr := client.ListThreads(requestContext, filter)
	if liveErr == nil {
		if allowCachedFallback {
			_ = cache.WriteThreads(key, result)
		}
		return machineDirectoryLoad[machinedirectory.ThreadsResult]{Result: result}, nil
	}
	if allowCachedFallback {
		cached, cacheErr := cache.ReadThreads(key, machineDirectoryCompletionCacheAge)
		if cacheErr == nil {
			return machineDirectoryLoad[machinedirectory.ThreadsResult]{
				Cached: true, Result: cached,
			}, nil
		}
	}
	return machineDirectoryLoad[machinedirectory.ThreadsResult]{}, liveErr
}

func resolveMachineDirectorySSH(
	ctx context.Context,
	machineID string,
) (machinedirectory.SSHResult, error) {
	client, _, _, err := machineDirectoryClient()
	if err != nil {
		return machinedirectory.SSHResult{}, err
	}
	return client.ResolveSSH(ctx, machineID)
}

func completionContext(
	ctx context.Context,
	bounded bool,
) (context.Context, context.CancelFunc) {
	if bounded {
		return context.WithTimeout(ctx, machineDirectoryCompletionTimeout)
	}
	return ctx, func() {}
}

func machineDirectoryCacheDirectory() string {
	if override := os.Getenv("PROJECT_CLI_CACHE_DIR"); override != "" {
		return filepath.Clean(override)
	}
	directory, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(directory, "project-space", "cli")
}
