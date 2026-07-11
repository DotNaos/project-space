package projectrun

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
)

func (manager *Manager) Status(ctx context.Context, directory, scriptName string) (ServeResult, error) {
	root, resolutionErr := manager.resolveSessionDirectory(directory, scriptName)
	if resolutionErr != nil && root == "" {
		return manager.configErrorResult("status", root, scriptName, resolutionErr), resolutionErr
	}

	unlock, err := acquireFileLock(manager.store.sessionLockPath(root, scriptName))
	if err != nil {
		return manager.runtimeErrorResult("status", root, scriptName, err), err
	}
	defer unlock()

	state, ok, err := manager.store.load(root, scriptName)
	if err != nil {
		return manager.runtimeErrorResult("status", root, scriptName, err), err
	}
	if !ok {
		return manager.statusWithoutState(root, scriptName, resolutionErr)
	}

	_, script, configErr := LoadScript(root, scriptName)
	if configErr != nil {
		return manager.removeUnavailableSession("status", state, configErr)
	}

	if state.State == StateRunning {
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

func (manager *Manager) Stop(_ context.Context, directory, scriptName string) (ServeResult, error) {
	root, resolutionErr := manager.resolveSessionDirectory(directory, scriptName)
	if resolutionErr != nil && root == "" {
		return manager.configErrorResult("stop", root, scriptName, resolutionErr), resolutionErr
	}

	unlock, err := acquireFileLock(manager.store.sessionLockPath(root, scriptName))
	if err != nil {
		return manager.runtimeErrorResult("stop", root, scriptName, err), err
	}
	defer unlock()

	state, ok, err := manager.store.load(root, scriptName)
	if err != nil {
		return manager.runtimeErrorResult("stop", root, scriptName, err), err
	}
	capability, configErr := manager.sessionCapability(root, scriptName)
	if !ok {
		if configErr != nil {
			return manager.unavailableResult("stop", root, scriptName, configErr), nil
		}
		return manager.stoppedResult("stop", root, scriptName, capability), nil
	}

	state.State = StateStopping
	state.CheckedAt = manager.timestamp()
	_ = manager.store.save(state)
	if cleanupErr := manager.cleanupRuntime(state); cleanupErr != nil {
		return manager.persistCleanupFailure("stop", capability, state, cleanupErr)
	}
	if err := manager.deleteSessionArtifacts(state); err != nil {
		clearRuntimeResources(&state)
		state.State = StateError
		state.LastError = err.Error()
		state.CheckedAt = manager.timestamp()
		_ = manager.store.save(state)
		return manager.resultFromState("stop", capability, state, err), err
	}
	return manager.stoppedResult("stop", root, scriptName, capability), nil
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
	unlock, err := acquireFileLock(manager.store.sessionLockPath(candidate.Directory, candidate.Script))
	if err != nil {
		return manager.resultFromState("reconcile", CapabilityUnavailable, candidate, err), true, err
	}
	defer unlock()

	state, ok, err := manager.store.load(candidate.Directory, candidate.Script)
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
	} else if state.State == StateRunning {
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
	stopped := runtimeState{
		Directory:    state.Directory,
		Script:       state.Script,
		State:        StateStopped,
		AllowedHosts: append([]string{}, state.AllowedHosts...),
		CheckedAt:    manager.timestamp(),
		LastError:    cause.Error(),
	}
	return manager.resultFromState("reconcile", capability, stopped, nil), true, nil
}

func (manager *Manager) resolveSessionDirectory(directory, script string) (string, error) {
	absolute, err := absoluteDirectory(directory)
	if err != nil {
		return "", err
	}
	if _, ok, loadErr := manager.store.load(absolute, script); loadErr != nil {
		return absolute, loadErr
	} else if ok {
		return absolute, nil
	}
	canonical, canonicalErr := canonicalDirectory(directory)
	if canonicalErr != nil {
		listing, listErr := manager.store.list()
		if listErr != nil {
			return absolute, listErr
		}
		for _, state := range listing.States {
			if state.Script == script && state.RequestedDirectory == absolute {
				return state.Directory, nil
			}
		}
		return absolute, errors.Join(append([]error{canonicalErr}, listing.Failures...)...)
	}
	return canonical, nil
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
	if err := manager.store.deleteLog(state.Directory, state.Script); err != nil {
		return err
	}
	return manager.store.delete(state.Directory, state.Script)
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
