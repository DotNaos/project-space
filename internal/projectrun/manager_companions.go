package projectrun

import (
	"context"
	"errors"
	"fmt"
)

func (manager *Manager) startCompanionServers(
	ctx context.Context,
	state *runtimeState,
) ([]CompanionServer, error) {
	companions := []CompanionServer{}
	for _, library := range state.Libraries {
		for _, script := range library.CompanionServers {
			identity, err := manager.identity.Resolve(ctx, library.Directory, script)
			if err != nil {
				return nil, err
			}
			unlock, err := acquireFileLock(manager.store.companionLockPath(identity.ServerID))
			if err != nil {
				return nil, err
			}
			result, err := manager.StartWithOptions(ctx, library.Directory, script, StartOptions{
				LocalOnly: true,
				APIs:      APIsModeSimulated,
				Data:      DataModeLocal,
			})
			if err != nil {
				unlock()
				rollbackErr := manager.rollbackCompanionStarts(state, companions)
				return nil, errors.Join(
					fmt.Errorf("start companion server %s in %s: %w", script, library.Directory, err),
					rollbackErr,
				)
			}
			owned := result.Disposition == ServeDispositionCreated || manager.companionHasOverlayOwner(result.ServerID, "")
			companions = append(companions, CompanionServer{
				Library: library.Directory, Script: script, Directory: result.Directory,
				ServerID: result.ServerID, State: result.State, LocalURL: result.LocalURL,
				Created: result.Disposition == ServeDispositionCreated, Owned: owned,
			})
			state.Companions = append([]CompanionServer{}, companions...)
			if err := manager.store.save(*state); err != nil {
				unlock()
				rollbackErr := manager.rollbackCompanionStarts(state, companions)
				return nil, errors.Join(err, rollbackErr)
			}
			unlock()
		}
	}
	return companions, nil
}

func (manager *Manager) rollbackCompanionStarts(state *runtimeState, companions []CompanionServer) error {
	state.Companions = append([]CompanionServer{}, companions...)
	persistErr := manager.store.save(*state)
	if cleanupErr := manager.cleanupCompanionServers(companions, state.ServerID); cleanupErr != nil {
		return errors.Join(persistErr, cleanupErr)
	}
	cleared := *state
	cleared.Companions = nil
	if err := manager.store.save(cleared); err != nil {
		return errors.Join(persistErr, err)
	}
	*state = cleared
	return persistErr
}

func (manager *Manager) cleanupCompanionServers(companions []CompanionServer, ownerServerID string) error {
	failures := []error{}
	for index := len(companions) - 1; index >= 0; index-- {
		companion := companions[index]
		unlock, err := acquireFileLock(manager.store.companionLockPath(companion.ServerID))
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if !companion.Owned || manager.companionHasOverlayOwner(companion.ServerID, ownerServerID) {
			unlock()
			continue
		}
		if _, err := manager.Stop(context.Background(), companion.Directory, companion.Script); err != nil {
			failures = append(failures, fmt.Errorf(
				"stop companion server %s in %s: %w", companion.Script, companion.Directory, err,
			))
		}
		unlock()
	}
	return errors.Join(failures...)
}

func (manager *Manager) companionHasOverlayOwner(companionServerID, excludedServerID string) bool {
	listing, err := manager.store.list()
	if err != nil || len(listing.Failures) > 0 {
		return true
	}
	for _, state := range listing.States {
		if state.ServerID == excludedServerID {
			continue
		}
		for _, companion := range state.Companions {
			if companion.ServerID == companionServerID && companion.Owned {
				return true
			}
		}
	}
	return false
}

func (manager *Manager) checkCompanionServers(ctx context.Context, companions []CompanionServer) error {
	for _, companion := range companions {
		identity, err := manager.resolveSessionIdentity(ctx, companion.Directory, companion.Script)
		if err != nil || identity.ServerID != companion.ServerID {
			return fmt.Errorf("companion server %s in %s changed identity", companion.Script, companion.Directory)
		}
		state, ok, err := manager.store.load(identity)
		if err != nil || !ok {
			return errors.Join(fmt.Errorf("companion server %s is unavailable", companion.Script), err)
		}
		_, script, err := LoadScript(companion.Directory, companion.Script)
		if err != nil {
			return err
		}
		if err := manager.checkRuntime(ctx, state, script); err != nil {
			return fmt.Errorf("companion server %s is unhealthy: %w", companion.Script, err)
		}
	}
	return nil
}
