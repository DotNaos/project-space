package main

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

type connectorRunSupervisor struct {
	runCalls int
	runErr   error
}

func (supervisor *connectorRunSupervisor) Run(context.Context) error {
	supervisor.runCalls++
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
