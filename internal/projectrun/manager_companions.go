package projectrun

import (
	"context"
	"errors"
	"fmt"
)

func (manager *Manager) startCompanionServers(
	ctx context.Context,
	libraries []LocalNodeLibrary,
) ([]CompanionServer, error) {
	companions := []CompanionServer{}
	for _, library := range libraries {
		for _, script := range library.CompanionServers {
			result, err := manager.StartWithOptions(ctx, library.Directory, script, StartOptions{
				LocalOnly: true,
				APIs:      APIsModeSimulated,
				Data:      DataModeLocal,
			})
			if err != nil {
				rollbackErr := manager.cleanupCompanionServers(companions)
				return nil, errors.Join(
					fmt.Errorf("start companion server %s in %s: %w", script, library.Directory, err),
					rollbackErr,
				)
			}
			companions = append(companions, CompanionServer{
				Library: library.Directory, Script: script, Directory: result.Directory,
				ServerID: result.ServerID, State: result.State, LocalURL: result.LocalURL,
				Created: result.Disposition == ServeDispositionCreated,
			})
		}
	}
	return companions, nil
}

func (manager *Manager) cleanupCompanionServers(companions []CompanionServer) error {
	failures := []error{}
	for index := len(companions) - 1; index >= 0; index-- {
		companion := companions[index]
		if !companion.Created {
			continue
		}
		if _, err := manager.Stop(context.Background(), companion.Directory, companion.Script); err != nil {
			failures = append(failures, fmt.Errorf(
				"stop companion server %s in %s: %w", companion.Script, companion.Directory, err,
			))
		}
	}
	return errors.Join(failures...)
}
