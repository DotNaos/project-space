package projectrun

import (
	"errors"
	"fmt"
	"os"
	"time"
)

func (manager *Manager) startLocalNodeWatchers(state *runtimeState) error {
	for _, library := range state.Libraries {
		for _, pkg := range library.Packages {
			if pkg.Mode != "watch" {
				continue
			}
			index := len(state.Watchers)
			logPath := manager.store.localNodeWatcherLogPath(state.ServerID, state.Generation, index)
			command := Command{
				Argv: append([]string{}, pkg.WatchCommand...), Dir: pkg.Directory, InheritEnv: true,
			}
			process, err := manager.processes.StartDetached(command, logPath, func(process ProcessRef) error {
				state.Watchers = append(state.Watchers, LocalNodeWatcher{
					Package: pkg.Name, Directory: pkg.Directory, Command: append([]string{}, pkg.WatchCommand...),
					PID: process.PID, ProcessIdentity: process.Identity, LogPath: logPath,
				})
				return manager.store.save(*state)
			})
			if err != nil {
				return fmt.Errorf("start local package watcher for %s: %w", pkg.Name, err)
			}
			if !manager.processes.Alive(process) {
				return fmt.Errorf("local package watcher for %s exited during startup", pkg.Name)
			}
		}
	}
	return nil
}

func (manager *Manager) checkLocalNodeWatchers(state runtimeState) error {
	for _, watcher := range state.Watchers {
		if !manager.processes.Alive(ProcessRef{PID: watcher.PID, Identity: watcher.ProcessIdentity}) {
			return fmt.Errorf("local package watcher for %s is not running", watcher.Package)
		}
	}
	return nil
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
	}
	return errors.Join(failures...)
}
