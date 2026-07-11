package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

func TestResolveConnectorBinaryFindsExecutableSibling(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows connector services are not supported")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	companion := filepath.Join(filepath.Dir(executable), "project-space-connector")
	if err := os.WriteFile(companion, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatalf("write sibling connector: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(companion) })

	originalWorkingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatalf("resolve working directory: %v", err)
	}
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatalf("change working directory: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(originalWorkingDirectory) })
	t.Setenv("PATH", "")

	resolved, err := resolveConnectorBinary("")
	if err != nil {
		t.Fatalf("resolve sibling connector: %v", err)
	}
	if resolved != companion {
		t.Fatalf("resolved connector = %q, want %q", resolved, companion)
	}
}

type connectorRunSupervisor struct {
	runCalls int
	runErr   error
	ctxErr   error
}

func (supervisor *connectorRunSupervisor) Run(ctx context.Context) error {
	supervisor.runCalls++
	supervisor.ctxErr = ctx.Err()
	return supervisor.runErr
}

func TestConnectorRunLoadsTheStoreAndRunsTheCompanionSupervisor(t *testing.T) {
	store := &commandStore{}
	supervisor := &connectorRunSupervisor{}
	newStoreCalls := 0
	resolveCalls := 0
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore: func() (machineconnect.CredentialStore, error) {
			newStoreCalls++
			return store, nil
		},
		ResolveBinary: func() (string, error) {
			resolveCalls++
			return "/opt/project/project-space-connector", nil
		},
		NewSupervisor: func(
			actualStore machineconnect.CredentialStore,
			binary string,
			_ io.Writer,
			_ io.Writer,
		) (connectorSupervisor, error) {
			if actualStore != store || binary != "/opt/project/project-space-connector" {
				t.Fatalf("unexpected supervisor inputs: store=%T binary=%q", actualStore, binary)
			}
			return supervisor, nil
		},
	})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute connector run: %v", err)
	}
	if newStoreCalls != 1 || resolveCalls != 1 || supervisor.runCalls != 1 {
		t.Fatalf(
			"run calls = store %d, resolve %d, supervisor %d; want one each",
			newStoreCalls,
			resolveCalls,
			supervisor.runCalls,
		)
	}
}

func TestConnectorRunStopsBeforeLaunchingWhenCredentialStoreFails(t *testing.T) {
	supervisor := &connectorRunSupervisor{}
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore: func() (machineconnect.CredentialStore, error) {
			return nil, errors.New("secure store unavailable")
		},
		ResolveBinary: func() (string, error) {
			t.Fatal("resolved companion after store failure")
			return "", nil
		},
		NewSupervisor: func(
			machineconnect.CredentialStore,
			string,
			io.Writer,
			io.Writer,
		) (connectorSupervisor, error) {
			return supervisor, nil
		},
	})

	if err := command.Execute(); err == nil {
		t.Fatal("expected secure store failure")
	}
	if supervisor.runCalls != 0 {
		t.Fatal("supervisor ran after store failure")
	}
}

func TestConnectorRunPropagatesCommandCancellation(t *testing.T) {
	store := &commandStore{}
	supervisor := &connectorRunSupervisor{}
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore:      func() (machineconnect.CredentialStore, error) { return store, nil },
		ResolveBinary: func() (string, error) { return "/opt/project/project-space-connector", nil },
		NewSupervisor: func(
			machineconnect.CredentialStore,
			string,
			io.Writer,
			io.Writer,
		) (connectorSupervisor, error) {
			return supervisor, nil
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	command.SetContext(ctx)

	if err := command.Execute(); err != nil {
		t.Fatalf("execute cancelled connector run: %v", err)
	}
	if !errors.Is(supervisor.ctxErr, context.Canceled) {
		t.Fatalf("supervisor context error = %v, want cancellation", supervisor.ctxErr)
	}
}

func TestConnectorCommandRegistersAuthenticatedRun(t *testing.T) {
	command, _, err := newConnectorCommand().Find([]string{"run"})
	if err != nil {
		t.Fatalf("find connector run: %v", err)
	}
	if command == nil || command.Name() != "run" {
		t.Fatalf("connector run command = %#v", command)
	}
}
