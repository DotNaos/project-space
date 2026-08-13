package projectrun

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"
)

func (manager *Manager) startLocalNodeWatchers(ctx context.Context, state *runtimeState) error {
	for _, library := range state.Libraries {
		for _, pkg := range library.Packages {
			if pkg.Mode != "watch" {
				continue
			}
			index := len(state.Watchers)
			logPath := manager.store.localNodeWatcherLogPath(state.ServerID, state.Generation, index)
			exitPath := manager.store.localNodeWatcherExitPath(state.ServerID, state.Generation, index)
			_ = os.Remove(exitPath)
			command := Command{
				Argv: append([]string{}, pkg.WatchCommand...), Dir: pkg.Directory, InheritEnv: true,
				ExitPath: exitPath,
			}
			process, err := manager.processes.StartDetached(command, logPath, func(process ProcessRef) error {
				state.Watchers = append(state.Watchers, LocalNodeWatcher{
					Package: pkg.Name, Directory: pkg.Directory, Command: append([]string{}, pkg.WatchCommand...),
					PID: process.PID, ProcessIdentity: process.Identity, LogPath: logPath, ExitPath: exitPath,
				})
				return manager.store.save(*state)
			})
			if err != nil {
				return fmt.Errorf("start local package watcher for %s: %w", pkg.Name, err)
			}
			if !manager.processes.Alive(process) {
				return fmt.Errorf("local package watcher for %s exited during startup", pkg.Name)
			}
			if err := waitForLocalNodeOutputs(ctx, pkg, exitPath, 15*time.Second); err != nil {
				return err
			}
		}
	}
	return nil
}

func (manager *Manager) checkLocalNodeWatchers(state runtimeState) error {
	for _, watcher := range state.Watchers {
		if watcher.ExitPath == "" {
			return fmt.Errorf("legacy local package watcher for %s requires a restart", watcher.Package)
		}
		if _, err := os.Stat(watcher.ExitPath); err == nil {
			return fmt.Errorf("local package watcher for %s exited; inspect %s", watcher.Package, watcher.LogPath)
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect local package watcher for %s: %w", watcher.Package, err)
		}
		if !manager.processes.Alive(ProcessRef{PID: watcher.PID, Identity: watcher.ProcessIdentity}) {
			return fmt.Errorf("local package watcher for %s is not running", watcher.Package)
		}
	}
	return nil
}

func waitForLocalNodeOutputs(ctx context.Context, pkg LocalNodePackage, exitPath string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		missing := ""
		for _, entry := range pkg.Imports {
			if info, err := os.Stat(entry.Path); err != nil || !info.Mode().IsRegular() {
				missing = entry.Path
				break
			}
		}
		if missing == "" {
			return nil
		}
		if _, err := os.Stat(exitPath); err == nil {
			return fmt.Errorf("local package watcher for %s exited before producing %s", pkg.Name, missing)
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect local package watcher for %s: %w", pkg.Name, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("local package watcher for %s did not produce %s", pkg.Name, missing)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (manager *Manager) cleanupLocalNodeWatchers(state runtimeState) error {
	var failures []error
	for index := len(state.Watchers) - 1; index >= 0; index-- {
		watcher := state.Watchers[index]
		process := ProcessRef{PID: watcher.PID, Identity: watcher.ProcessIdentity}
		if manager.processes.Alive(process) {
			if err := manager.processes.StopGroup(process, 3*time.Second); err != nil {
				failures = append(failures, fmt.Errorf("stop local package watcher for %s: %w", watcher.Package, err))
			}
		}
	}
	return errors.Join(failures...)
}

func deleteLocalNodeWatcherLogs(watchers []LocalNodeWatcher) error {
	var failures []error
	for _, watcher := range watchers {
		if err := os.Remove(watcher.LogPath); err != nil && !os.IsNotExist(err) {
			failures = append(failures, fmt.Errorf("remove local package watcher log: %w", err))
		}
		if watcher.ExitPath != "" {
			if err := os.Remove(watcher.ExitPath); err != nil && !os.IsNotExist(err) {
				failures = append(failures, fmt.Errorf("remove local package watcher exit marker: %w", err))
			}
		}
	}
	return errors.Join(failures...)
}
