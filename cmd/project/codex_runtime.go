package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/DotNaos/project-space/internal/codextask"
	"github.com/DotNaos/project-space/internal/machineconnect"
)

type codexCommandRuntime struct {
	client           codexTaskAPI
	localMachineName string
}

type codexCommandDependencies struct {
	AuthorizationPollAttempts int
	AuthorizationPollInterval time.Duration
	AttachLocal               func(context.Context, string, string, io.Reader, io.Writer, io.Writer) error
	AttachRemote              func(context.Context, string, string, string, string, io.Reader, io.Writer, io.Writer) error
	LoadRuntime               func(context.Context) (codexCommandRuntime, error)
	LookupEnv                 func(string) (string, bool)
	NewClient                 func(codextask.Config) (codexTaskAPI, error)
	NewCredentialStore        func() (machineconnect.CredentialStore, error)
	NewOperationID            func(string) (string, error)
	ResolveBinary             func(context.Context, string) (string, error)
	ResolveRepository         func(context.Context) (string, error)
	Wait                      func(context.Context, time.Duration) error
}

func normalizeCodexCommandDependencies(dependencies codexCommandDependencies) codexCommandDependencies {
	if dependencies.LookupEnv == nil {
		dependencies.LookupEnv = os.LookupEnv
	}
	if dependencies.NewCredentialStore == nil {
		dependencies.NewCredentialStore = machineconnect.NewDefaultCredentialStore
	}
	if dependencies.NewClient == nil {
		dependencies.NewClient = func(config codextask.Config) (codexTaskAPI, error) {
			return codextask.NewClient(config)
		}
	}
	if dependencies.NewOperationID == nil {
		dependencies.NewOperationID = newCodexOperationID
	}
	if dependencies.AuthorizationPollAttempts < 1 {
		dependencies.AuthorizationPollAttempts = 450
	}
	if dependencies.AuthorizationPollInterval <= 0 {
		dependencies.AuthorizationPollInterval = 2 * time.Second
	}
	if dependencies.Wait == nil {
		dependencies.Wait = func(ctx context.Context, duration time.Duration) error {
			timer := time.NewTimer(duration)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		}
	}
	if dependencies.ResolveBinary == nil {
		dependencies.ResolveBinary = resolveCodexBinary
	}
	if dependencies.ResolveRepository == nil {
		dependencies.ResolveRepository = resolveCurrentGitHubRepository
	}
	if dependencies.AttachLocal == nil {
		dependencies.AttachLocal = runLocalCodexAttach
	}
	if dependencies.AttachRemote == nil {
		dependencies.AttachRemote = runRemoteCodexAttach
	}
	if dependencies.LoadRuntime == nil {
		dependencies.LoadRuntime = func(ctx context.Context) (codexCommandRuntime, error) {
			return loadCodexCommandRuntime(ctx, dependencies)
		}
	}
	return dependencies
}

func loadCodexCommandRuntime(_ context.Context, dependencies codexCommandDependencies) (codexCommandRuntime, error) {
	store, err := dependencies.NewCredentialStore()
	if err != nil || store == nil {
		return codexCommandRuntime{}, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return codexCommandRuntime{}, errors.New("this machine is not connected to Project Space")
	}
	token := credential.Token
	provider := codextask.CredentialProviderFunc(func(context.Context) (string, error) {
		return token, nil
	})
	threadID, _ := dependencies.LookupEnv("CODEX_THREAD_ID")
	client, err := dependencies.NewClient(codextask.Config{
		BaseURL: credential.BackendURL, CallerMachineID: credential.MachineID,
		CallerThreadID: threadID, CredentialProvider: provider,
	})
	if err != nil || client == nil {
		return codexCommandRuntime{}, codextask.ErrInvalidConfig
	}
	return codexCommandRuntime{client: client, localMachineName: credential.MachineName}, nil
}

func newCodexOperationID(prefix string) (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate Codex operation ID: %w", err)
	}
	return prefix + ":" + hex.EncodeToString(value), nil
}
