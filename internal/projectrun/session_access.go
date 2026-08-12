package projectrun

import (
	"context"
	"errors"
	"fmt"
)

type SessionAccess struct {
	Result  ServeResult
	LogPath string
}

func (manager *Manager) ListSessions(ctx context.Context) (ServeCollectionResult, error) {
	result := ServeCollectionResult{
		SchemaVersion: SchemaVersion,
		Operation:     "list",
		CheckedAt:     manager.timestamp(),
		Sessions:      []ServeResult{},
	}
	listing, err := manager.store.list()
	if err != nil {
		result.ErrorCount = 1
		return result, err
	}
	failures := append([]error{}, listing.Failures...)
	for _, candidate := range listing.States {
		if err := ctx.Err(); err != nil {
			failures = append(failures, err)
			break
		}
		session, statusErr := manager.Status(ctx, candidate.Directory, candidate.Script)
		session.Operation = "list"
		result.Sessions = append(result.Sessions, session)
		if statusErr != nil {
			failures = append(failures, fmt.Errorf(
				"inspect %s (%s): %w", candidate.Directory, candidate.Script, statusErr,
			))
		}
	}
	result.ErrorCount = len(failures)
	result.CheckedAt = manager.timestamp()
	return result, errors.Join(failures...)
}

// ObserveSessions returns validated persisted session evidence without running
// health checks or cleanup. Callers that need a global inventory must use this
// boundary so observing one Workspace cannot mutate another Workspace.
func (manager *Manager) ObserveSessions(ctx context.Context) (ServeCollectionResult, error) {
	result := ServeCollectionResult{
		SchemaVersion: SchemaVersion,
		Operation:     "observe",
		CheckedAt:     manager.timestamp(),
		Sessions:      []ServeResult{},
	}
	if err := ctx.Err(); err != nil {
		result.ErrorCount = 1
		return result, err
	}
	listing, err := manager.store.list()
	if err != nil {
		result.ErrorCount = 1
		return result, err
	}
	for _, state := range listing.States {
		session := manager.resultFromState("observe", CapabilityConfigured, state, nil)
		result.Sessions = append(result.Sessions, session)
	}
	result.ErrorCount = len(listing.Failures)
	result.CheckedAt = manager.timestamp()
	return result, errors.Join(listing.Failures...)
}

func (manager *Manager) AccessSession(
	ctx context.Context,
	directory string,
	script string,
) (SessionAccess, error) {
	identity, err := manager.resolveSessionIdentity(ctx, directory, script)
	if err != nil && identity.ServerID == "" {
		return SessionAccess{}, err
	}
	unlock, err := acquireFileLock(manager.store.sessionLockPath(identity.ServerID))
	if err != nil {
		return SessionAccess{}, err
	}
	defer unlock()
	state, exists, err := manager.store.load(identity)
	if err != nil {
		return SessionAccess{}, err
	}
	if !exists {
		return SessionAccess{}, fmt.Errorf("managed project server %q is not running", script)
	}
	observation, err := manager.tmux.Inspect(ctx, state.TmuxSession)
	if err != nil {
		return SessionAccess{}, err
	}
	if !observation.Exists || !sameTmuxOwnership(observation.Spec, tmuxSpecFromState(state)) {
		return SessionAccess{}, fmt.Errorf("managed tmux session %q is missing or no longer owned", state.TmuxSession)
	}
	return SessionAccess{
		Result:  manager.resultFromState("access", CapabilityConfigured, state, nil),
		LogPath: manager.store.logPath(state.ServerID),
	}, nil
}
