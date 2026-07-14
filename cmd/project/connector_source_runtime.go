package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/gofrs/flock"
)

type connectorSourceRuntime struct {
	mu         sync.Mutex
	supervisor connectorSupervisor
	cancel     context.CancelFunc
	done       chan error
}

type connectorSourceLockedSupervisor struct {
	lockPath string
	inner    connectorSupervisor
}

func newConnectorSourceLockedSupervisor(
	profile machineconnect.ConnectorProfile,
	inner connectorSupervisor,
) connectorSupervisor {
	return &connectorSourceLockedSupervisor{lockPath: profile.RuntimeLockPath, inner: inner}
}

func (supervisor *connectorSourceLockedSupervisor) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("source connector context is missing")
	}
	directory := filepath.Dir(supervisor.lockPath)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create source connector state directory: %w", err)
	}
	if info, err := os.Lstat(directory); err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("source connector state directory is unsafe")
	}
	if info, err := os.Lstat(supervisor.lockPath); err == nil &&
		(info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular()) {
		return errors.New("source connector runtime lock is unsafe")
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("inspect source connector runtime lock: %w", err)
	}
	lock := flock.New(supervisor.lockPath, flock.SetPermissions(0o600))
	locked, err := lock.TryLock()
	if err != nil {
		_ = lock.Close()
		return fmt.Errorf("lock source connector runtime: %w", err)
	}
	if !locked {
		_ = lock.Close()
		return machineconnect.ErrConnectorRuntimeAlreadyRunning
	}
	defer lock.Close()
	return supervisor.inner.Run(ctx)
}

func (runtime *connectorSourceRuntime) Start(ctx context.Context) error {
	if ctx == nil {
		return errors.New("source connector context is missing")
	}
	runtime.mu.Lock()
	if runtime.done != nil {
		select {
		case <-runtime.done:
			runtime.cancel = nil
			runtime.done = nil
		default:
			runtime.mu.Unlock()
			return nil
		}
	}
	runContext, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	runtime.cancel = cancel
	runtime.done = done
	runtime.mu.Unlock()
	go func() { done <- runtime.supervisor.Run(runContext) }()
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	select {
	case err := <-done:
		runtime.clear(done)
		cancel()
		return err
	case <-timer.C:
		return nil
	}
}

func (runtime *connectorSourceRuntime) Stop(ctx context.Context) error {
	runtime.mu.Lock()
	done := runtime.done
	cancel := runtime.cancel
	runtime.mu.Unlock()
	if done == nil {
		return nil
	}
	cancel()
	select {
	case err := <-done:
		runtime.clear(done)
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (runtime *connectorSourceRuntime) clear(done chan error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.done == done {
		runtime.done = nil
		runtime.cancel = nil
	}
}
