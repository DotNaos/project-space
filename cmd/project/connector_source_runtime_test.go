package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

func TestSourceConnectorProfileLockRejectsCompetingRuntime(t *testing.T) {
	profile, err := machineconnect.NewDevelopmentConnectorProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	owner := newConnectorSourceLockedSupervisor(profile, &sourceTestSupervisor{run: func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}})
	ownerContext, cancelOwner := context.WithCancel(context.Background())
	ownerDone := make(chan error, 1)
	go func() { ownerDone <- owner.Run(ownerContext) }()
	<-started

	contender := newConnectorSourceLockedSupervisor(profile, &sourceTestSupervisor{run: func(context.Context) error {
		t.Fatal("competing source connector reached its companion")
		return nil
	}})
	startedAt := time.Now()
	if err := contender.Run(context.Background()); !errors.Is(err, machineconnect.ErrConnectorRuntimeAlreadyRunning) {
		t.Fatalf("competing source connector error = %v", err)
	}
	if time.Since(startedAt) > 100*time.Millisecond {
		t.Fatal("competing source connector waited instead of failing immediately")
	}

	cancelOwner()
	if err := <-ownerDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("owner exit = %v", err)
	}
	if filepath.Dir(profile.RuntimeLockPath) != profile.StateRoot {
		t.Fatal("source runtime lock escaped the development profile")
	}
}

func TestSourceConnectorRuntimeCanRestartAfterLateExit(t *testing.T) {
	exits := make(chan struct{}, 2)
	supervisor := &sourceTestSupervisor{run: func(context.Context) error {
		<-exits
		return errors.New("source exited")
	}}
	runtime := &connectorSourceRuntime{supervisor: supervisor}
	if err := runtime.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	exits <- struct{}{}
	time.Sleep(20 * time.Millisecond)
	if err := runtime.Start(context.Background()); err != nil {
		t.Fatalf("restart after late exit: %v", err)
	}
	if supervisor.calls.Load() != 2 {
		t.Fatalf("source supervisor calls = %d, want 2", supervisor.calls.Load())
	}
	exits <- struct{}{}
}

func TestConnectorSourceRuntimeWaitStopsOnCancellation(t *testing.T) {
	started := make(chan struct{})
	runtime := &connectorSourceRuntime{supervisor: &sourceTestSupervisor{
		run: func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		},
	}}
	runContext, cancelRun := context.WithCancel(context.Background())
	if err := runtime.Start(runContext); err != nil {
		t.Fatalf("start runtime: %v", err)
	}
	<-started
	cancelRun()
	if err := runtime.Wait(runContext); err != nil {
		t.Fatalf("wait for cancelled runtime: %v", err)
	}
	if runtime.Running() {
		t.Fatal("cancelled runtime still reports running")
	}
}
