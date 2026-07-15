package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

type sourceTestSupervisor struct {
	run   func(context.Context) error
	calls atomic.Int32
}

func (supervisor *sourceTestSupervisor) Run(ctx context.Context) error {
	supervisor.calls.Add(1)
	return supervisor.run(ctx)
}

func TestConnectorCommandRegistersSourceRuntime(t *testing.T) {
	command, _, err := newConnectorCommand().Find([]string{"source", "run"})
	if err != nil {
		t.Fatalf("find source connector command: %v", err)
	}
	if command.CommandPath() != "connector source run" {
		t.Fatalf("source connector command path = %q", command.CommandPath())
	}
}

func TestSourceConnectorCommandExposesExplicitProfileWithoutNameInference(t *testing.T) {
	dependencies, backend, supervisor := sourceCommandTestDependencies(t)
	backend.state = machineconnect.ConnectionOnline
	command := newConnectorSourceCommandWithDependencies(dependencies)
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"connect", "--root", sourceConnectorCheckoutFixture(t), "--name", "ordinary-machine", "--json"})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute source connect: %v", err)
	}
	if backend.created.Name != "ordinary-machine" || backend.created.Channel != "dev" ||
		backend.created.Source != "source" || supervisor.calls.Load() != 1 {
		t.Fatalf("source connect side effects: machine=%#v supervisor=%d", backend.created, supervisor.calls.Load())
	}
	if !strings.Contains(stdout.String(), `"channel": "dev"`) ||
		!strings.Contains(stdout.String(), `"profile": "dev"`) ||
		!strings.Contains(stdout.String(), `"source": "source"`) {
		t.Fatalf("source connector metadata missing from %s", stdout.String())
	}
}

func TestSourceConnectorRunUsesIsolatedStoreAndForegroundSupervisor(t *testing.T) {
	dependencies, _, supervisor := sourceCommandTestDependencies(t)
	supervisor.run = func(context.Context) error { return errors.New("source stopped") }
	command := newConnectorSourceCommandWithDependencies(dependencies)
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	command.SetArgs([]string{"run", "--root", sourceConnectorCheckoutFixture(t)})

	err := command.Execute()
	if err == nil || err.Error() != "source stopped" || supervisor.calls.Load() != 1 {
		t.Fatalf("source run error=%v calls=%d", err, supervisor.calls.Load())
	}
}

func TestSourceConnectorRuntimeStopsOnlyItsOwnSupervisor(t *testing.T) {
	started := make(chan struct{})
	supervisor := &sourceTestSupervisor{run: func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}}
	runtime := &connectorSourceRuntime{supervisor: supervisor}
	if err := runtime.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runtime.Stop(ctx); err != nil {
		t.Fatalf("stop source connector runtime: %v", err)
	}
	if supervisor.calls.Load() != 1 {
		t.Fatalf("source supervisor calls = %d", supervisor.calls.Load())
	}
}

func sourceCommandTestDependencies(
	t *testing.T,
) (connectorSourceDependencies, *commandBackend, *sourceTestSupervisor) {
	t.Helper()
	profile, err := machineconnect.NewDevelopmentConnectorProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	backend := &commandBackend{
		request: machineconnect.Request{
			ID: "request", PollToken: "poll", ApprovalURL: "https://approval.example/connect",
			ExpiresAt: time.Now().Add(time.Minute), PollInterval: time.Millisecond,
		},
		approval: machineconnect.Approval{State: machineconnect.ApprovalApproved, Challenge: "challenge"},
		credential: machineconnect.Credential{
			BackendURL: "https://projects.example.test", MachineID: "machine-dev",
			MachineName: "ordinary-machine", Token: "source-secret", IssuedAt: time.Now(),
		},
		state: machineconnect.ConnectionOnline,
	}
	supervisor := &sourceTestSupervisor{run: func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}}
	return connectorSourceDependencies{
		NewProfile: func() (machineconnect.ConnectorProfile, error) { return profile, nil },
		NewStore: func(machineconnect.ConnectorProfile) (machineconnect.CredentialStore, error) {
			return &commandStore{}, nil
		},
		NewBackend: func() (machineconnect.Backend, error) { return backend, nil },
		NewSupervisor: func(
			context.Context,
			machineconnect.ConnectorProfile,
			string,
			machineconnect.CredentialStore,
			io.Writer,
			io.Writer,
		) (connectorSupervisor, error) {
			return supervisor, nil
		},
		Hostname: func() (string, error) { return "ordinary-host", nil },
		Headless: func() bool { return true },
		GOOS:     "linux",
		GOARCH:   "amd64",
		Version:  "0.4.5",
	}, backend, supervisor
}
