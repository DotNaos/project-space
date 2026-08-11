package projectrun

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
)

func (manager *Manager) Status(ctx context.Context, directory, scriptName string) (ServeResult, error) {
	identity, resolutionErr := manager.resolveSessionIdentity(ctx, directory, scriptName)
	if resolutionErr != nil && identity.ServerID == "" {
		return manager.configErrorResult("status", identity.WorktreePath, scriptName, resolutionErr), resolutionErr
	}

	unlock, err := acquireFileLock(manager.store.sessionLockPath(identity.ServerID))
	if err != nil {
		return manager.runtimeErrorResult("status", identity.WorktreePath, scriptName, err), err
	}
	defer unlock()

	state, ok, err := manager.store.load(identity)
	if err != nil {
		return manager.runtimeErrorResult("status", identity.WorktreePath, scriptName, err), err
	}
	if !ok {
		result, statusErr := manager.statusWithoutState(identity.WorktreePath, scriptName, resolutionErr)
		return decorateServeIdentity(result, identity), statusErr
	}

	_, script, configErr := LoadScript(identity.WorktreePath, scriptName)
	if configErr != nil {
		return manager.removeUnavailableSession("status", state, configErr)
	}

	if state.State == StateRunning || state.State == StateLocalOnly {
		healthErr := manager.checkRuntime(ctx, state, script)
		if healthErr == nil {
			state.CheckedAt = manager.timestamp()
			state.LastError = ""
			if err := manager.store.save(state); err != nil {
				return manager.resultFromState("status", CapabilityConfigured, state, err), err
			}
			return manager.resultFromState("status", CapabilityConfigured, state, nil), nil
		}
		if isContextError(healthErr) {
			return manager.resultFromState("status", CapabilityConfigured, state, healthErr), healthErr
		}
		if isTransientRuntimeError(healthErr) {
			return manager.preserveRuntimeAfterTransientFailure(
				"status", CapabilityConfigured, state, healthErr,
			)
		}
		return manager.markStatusError(state, healthErr)
	}

	if state.State == StateStarting || state.State == StateStopping {
		cause := fmt.Errorf("serve session was interrupted while %s", state.State)
		return manager.markStatusError(state, cause)
	}
	if state.State != StateError || hasRuntimeResources(state) {
		cause := errors.New("serve session has an invalid persisted state")
		if state.State == StateError && state.LastError != "" {
			cause = errors.New(state.LastError)
		}
		return manager.markStatusError(state, cause)
	}
	return manager.resultFromState("status", CapabilityConfigured, state, nil), nil
}

func (manager *Manager) Stop(ctx context.Context, directory, scriptName string) (ServeResult, error) {
	identity, resolutionErr := manager.resolveSessionIdentity(ctx, directory, scriptName)
	if resolutionErr != nil && identity.ServerID == "" {
		return manager.unavailableResult("stop", identity.WorktreePath, scriptName, resolutionErr), nil
	}

	unlock, err := acquireFileLock(manager.store.sessionLockPath(identity.ServerID))
	if err != nil {
		return manager.runtimeErrorResult("stop", identity.WorktreePath, scriptName, err), err
	}
	defer unlock()

	state, ok, err := manager.store.load(identity)
	if err != nil {
		return manager.runtimeErrorResult("stop", identity.WorktreePath, scriptName, err), err
	}
	capability, configErr := manager.sessionCapability(identity.WorktreePath, scriptName)
	if !ok {
		if configErr != nil {
			return decorateServeIdentity(
				manager.unavailableResult("stop", identity.WorktreePath, scriptName, configErr), identity,
			), nil
		}
		return decorateServeIdentity(
			manager.stoppedResult("stop", identity.WorktreePath, scriptName, capability), identity,
		), nil
	}

	state.State = StateStopping
	state.CheckedAt = manager.timestamp()
	_ = manager.store.save(state)
	if cleanupErr := manager.cleanupRuntime(state); cleanupErr != nil {
		return manager.persistCleanupFailure("stop", capability, state, cleanupErr)
	}
	stopped := state
	clearRuntimeResources(&stopped)
	stopped.State = StateStopped
	stopped.LastError = ""
	stopped.CheckedAt = manager.timestamp()
	if err := manager.deleteSessionArtifacts(state); err != nil {
		clearRuntimeResources(&state)
		state.State = StateError
		state.LastError = err.Error()
		state.CheckedAt = manager.timestamp()
		_ = manager.store.save(state)
		return manager.resultFromState("stop", capability, state, err), err
	}
	return manager.resultFromState("stop", capability, stopped, nil), nil
}

func (manager *Manager) Reconcile(ctx context.Context) (ServeCollectionResult, error) {
	result := ServeCollectionResult{
		SchemaVersion: SchemaVersion,
		Operation:     "reconcile",
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

	failures := append([]error{}, listing.Failures...)
	result.ErrorCount = len(failures)
	for _, candidate := range listing.States {
		if err := ctx.Err(); err != nil {
			result.ErrorCount++
			failures = append(failures, err)
			break
		}
		session, included, reconcileErr := manager.reconcileSession(ctx, candidate)
		if included {
			result.Sessions = append(result.Sessions, session)
		}
		if reconcileErr != nil {
			result.ErrorCount++
			failures = append(failures, fmt.Errorf("reconcile %s (%s): %w",
				candidate.Directory, candidate.Script, reconcileErr))
		}
	}
	result.CheckedAt = manager.timestamp()
	return result, errors.Join(failures...)
}

func (manager *Manager) reconcileSession(
	ctx context.Context,
	candidate runtimeState,
) (ServeResult, bool, error) {
	identity := identityFromState(candidate)
	unlock, err := acquireFileLock(manager.store.sessionLockPath(candidate.ServerID))
	if err != nil {
		return manager.resultFromState("reconcile", CapabilityUnavailable, candidate, err), true, err
	}
	defer unlock()

	state, ok, err := manager.store.load(identity)
	if err != nil {
		return manager.resultFromState("reconcile", CapabilityUnavailable, candidate, err), true, err
	}
	if !ok {
		return ServeResult{}, false, nil
	}

	_, script, configErr := LoadScript(state.Directory, state.Script)
	capability := CapabilityConfigured
	if configErr != nil {
		capability = CapabilityUnavailable
	}
	var cause error
	if configErr != nil {
		cause = configErr
	} else if state.State == StateRunning || state.State == StateLocalOnly {
		healthErr := manager.checkRuntime(ctx, state, script)
		if healthErr == nil {
			state.CheckedAt = manager.timestamp()
			state.LastError = ""
			if err := manager.store.save(state); err != nil {
				return manager.resultFromState("reconcile", capability, state, err), true, err
			}
			return manager.resultFromState("reconcile", capability, state, nil), true, nil
		}
		if isContextError(healthErr) {
			return manager.resultFromState("reconcile", capability, state, healthErr), true, healthErr
		}
		if isTransientRuntimeError(healthErr) {
			result, transientErr := manager.preserveRuntimeAfterTransientFailure(
				"reconcile", capability, state, healthErr,
			)
			return result, true, transientErr
		}
		cause = healthErr
	} else if state.State == StateStarting || state.State == StateStopping {
		cause = fmt.Errorf("serve session was interrupted while %s", state.State)
	} else if state.LastError != "" {
		cause = errors.New(state.LastError)
	} else {
		cause = fmt.Errorf("serve session was persisted in state %s", state.State)
	}

	if cleanupErr := manager.cleanupRuntime(state); cleanupErr != nil {
		combined := errors.Join(cause, cleanupErr)
		result, persistErr := manager.persistCleanupFailure("reconcile", capability, state, combined)
		return result, true, persistErr
	}
	if err := manager.deleteSessionArtifacts(state); err != nil {
		combined := errors.Join(cause, err)
		clearRuntimeResources(&state)
		state.State = StateError
		state.LastError = combined.Error()
		state.CheckedAt = manager.timestamp()
		_ = manager.store.save(state)
		return manager.resultFromState("reconcile", capability, state, combined), true, combined
	}
	stopped := state
	clearRuntimeResources(&stopped)
	stopped.State = StateStopped
	stopped.CheckedAt = manager.timestamp()
	stopped.LastError = cause.Error()
	return manager.resultFromState("reconcile", capability, stopped, nil), true, nil
}

func (manager *Manager) resolveSessionIdentity(
	ctx context.Context,
	directory string,
	script string,
) (ServerIdentity, error) {
	absolute, err := absoluteDirectory(directory)
	if err != nil {
		return ServerIdentity{}, err
	}
	canonical, canonicalErr := canonicalDirectory(directory)
	if canonicalErr == nil {
		identity, identityErr := manager.identity.Resolve(ctx, canonical, script)
		if identityErr == nil {
			return identity, nil
		}
		canonicalErr = identityErr
	}
	listing, listErr := manager.store.list()
	if listErr != nil {
		return ServerIdentity{WorktreePath: absolute, ServerKey: script}, listErr
	}
	for _, state := range listing.States {
		if state.Script == script && (state.RequestedDirectory == absolute || state.Directory == canonical || state.Directory == absolute) {
			return identityFromState(state), nil
		}
	}
	return ServerIdentity{WorktreePath: absolute, ServerKey: script},
		errors.Join(append([]error{canonicalErr}, listing.Failures...)...)
}

func absoluteDirectory(directory string) (string, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", fmt.Errorf("resolve project directory: %w", err)
	}
	return filepath.Clean(absolute), nil
}

func (manager *Manager) statusWithoutState(
	root string,
	scriptName string,
	resolutionErr error,
) (ServeResult, error) {
	if resolutionErr != nil {
		return manager.configErrorResult("status", root, scriptName, resolutionErr), resolutionErr
	}
	_, _, configErr := LoadScript(root, scriptName)
	if errors.Is(configErr, ErrNotConfigured) || errors.Is(configErr, ErrScriptNotFound) {
		return manager.unavailableResult("status", root, scriptName, configErr), nil
	}
	if configErr != nil {
		return manager.configErrorResult("status", root, scriptName, configErr), configErr
	}
	return manager.stoppedResult("status", root, scriptName, CapabilityConfigured), nil
}

func (manager *Manager) sessionCapability(directory, script string) (Capability, error) {
	if _, _, err := LoadScript(directory, script); err != nil {
		return CapabilityUnavailable, err
	}
	return CapabilityConfigured, nil
}

func (manager *Manager) removeUnavailableSession(
	operation string,
	state runtimeState,
	configErr error,
) (ServeResult, error) {
	if cleanupErr := manager.cleanupRuntime(state); cleanupErr != nil {
		combined := errors.Join(configErr, cleanupErr)
		return manager.persistCleanupFailure(operation, CapabilityUnavailable, state, combined)
	}
	if err := manager.deleteSessionArtifacts(state); err != nil {
		combined := errors.Join(configErr, err)
		clearRuntimeResources(&state)
		state.State = StateError
		state.LastError = combined.Error()
		state.CheckedAt = manager.timestamp()
		_ = manager.store.save(state)
		return manager.resultFromState(operation, CapabilityUnavailable, state, combined), combined
	}
	return manager.unavailableResult(operation, state.Directory, state.Script, configErr), nil
}

func (manager *Manager) markStatusError(state runtimeState, cause error) (ServeResult, error) {
	cleanupErr := manager.cleanupRuntime(state)
	if cleanupErr == nil {
		clearRuntimeResources(&state)
	} else {
		cause = errors.Join(cause, cleanupErr)
	}
	state.State = StateError
	state.LastError = cause.Error()
	state.CheckedAt = manager.timestamp()
	if err := manager.store.save(state); err != nil {
		return manager.resultFromState("status", CapabilityConfigured, state, err), err
	}
	return manager.resultFromState("status", CapabilityConfigured, state, nil), nil
}

func (manager *Manager) persistCleanupFailure(
	operation string,
	capability Capability,
	state runtimeState,
	cause error,
) (ServeResult, error) {
	state.State = StateError
	state.LastError = cause.Error()
	state.CheckedAt = manager.timestamp()
	if err := manager.store.save(state); err != nil {
		cause = errors.Join(cause, err)
	}
	return manager.resultFromState(operation, capability, state, cause), cause
}

func (manager *Manager) deleteSessionArtifacts(state runtimeState) error {
	if err := manager.store.deleteLog(state.ServerID); err != nil {
		return err
	}
	return manager.store.delete(state.ServerID)
}

func clearRuntimeResources(state *runtimeState) {
	state.PID, state.ProcessID = 0, ""
	state.LocalPort, state.PublicPort = 0, 0
	state.TailscaleIPv4 = ""
	state.StartedAt = ""
}

func hasRuntimeResources(state runtimeState) bool {
	return state.PID > 0 || state.LocalPort > 0 || state.PublicPort > 0
}

func identityFromState(state runtimeState) ServerIdentity {
	return ServerIdentity{
		RepositoryPath: state.RepositoryPath,
		WorktreePath:   state.Directory,
		ServerKey:      state.Script,
		ServerID:       state.ServerID,
		TmuxSession:    state.TmuxSession,
	}
}

func decorateServeIdentity(result ServeResult, identity ServerIdentity) ServeResult {
	result.Mode = ServeModeManaged
	result.ServerID = identity.ServerID
	result.ServerKey = identity.ServerKey
	result.Repository = identity.RepositoryPath
	result.Directory = identity.WorktreePath
	result.Script = identity.ServerKey
	result.TmuxSession = identity.TmuxSession
	return result
}
