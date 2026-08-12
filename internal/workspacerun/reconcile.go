package workspacerun

import (
	"context"
	"fmt"
)

func (manager *Manager) Reconcile(ctx context.Context, directory string, options OperationOptions) (Result, error) {
	if err := requireExpectedGeneration(options); err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "reconcile", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	identity, err := manager.resolveIdentity(ctx, directory, options)
	if err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "reconcile", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	var result Result
	err = manager.store.withLock(identity.WorkspaceID, func() error {
		record, exists, err := manager.store.load(identity)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("Workspace runtime does not exist")
		}
		if err := verifyStoredBinding(record, options); err != nil {
			result = manager.result("reconcile", "", record, err)
			return err
		}
		provider, err := manager.provider(record.Mode)
		if err != nil {
			return err
		}
		switch record.State {
		case StateRunning:
			if err := manager.inspectResources(ctx, provider, record); err == nil {
				record.CheckedAt = manager.timestamp()
				record.LastError = ""
				if err := manager.store.save(record); err != nil {
					return err
				}
				result = manager.result("reconcile", DispositionReused, record, nil)
				return nil
			}
			observation, inspectErr := provider.Inspect(ctx, record.Handle, record.binding())
			if inspectErr != nil || (observation.Exists && !observation.Owned) {
				cause := fmt.Errorf("runtime ownership is ambiguous; no resource was changed")
				record.State = StateStale
				record.LastError = cause.Error()
				record.CheckedAt = manager.timestamp()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, cause)
				return cause
			}
			if observation.Exists {
				cause := fmt.Errorf("runtime resources disagree while the owned process is alive; no resource was changed")
				record.State = StateStale
				record.LastError = cause.Error()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, cause)
				return cause
			}
			if len(record.DevServers) > 0 {
				cause := fmt.Errorf("runtime process is absent while dev-server resources remain; no resource was changed")
				record.State = StateStale
				record.LastError = cause.Error()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, cause)
				return cause
			}
			record.State = StateFailed
			record.Handle = RuntimeHandle{}
			record.LastError = "runtime process exited before reconciliation"
		case StateSuspended:
			if err := manager.inspectSuspended(ctx, provider, record); err != nil {
				record.State = StateStale
				record.LastError = err.Error()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, err)
				return err
			}
		case StateStarting, StateSuspending, StateResuming:
			if err := manager.preflightOwned(ctx, provider, record); err != nil {
				record.State = StateStale
				record.LastError = err.Error()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, err)
				return err
			}
			if err := manager.cleanupOwned(ctx, provider, &record); err != nil {
				record.State = StateStale
				record.LastError = err.Error()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, err)
				return err
			}
			record.State = StateFailed
			record.Handle = RuntimeHandle{}
			record.DevServers = []ManagedDevServer{}
			record.LastError = "interrupted runtime transition was rolled back"
		case StateStopping:
			if err := manager.preflightOwned(ctx, provider, record); err != nil {
				return err
			}
			if err := manager.cleanupOwned(ctx, provider, &record); err != nil {
				return err
			}
			record.State = StateStopped
			record.DevServers = []ManagedDevServer{}
			record.LastError = ""
		case StateCleaning:
			if len(record.DevServers) > 0 {
				return fmt.Errorf("cleaning state still contains dev-server resources")
			}
			if record.Handle.Kind != "" {
				observation, inspectErr := provider.Inspect(ctx, record.Handle, record.binding())
				if inspectErr != nil {
					return fmt.Errorf("cleaning runtime resource absence cannot be proven: %w", inspectErr)
				}
				if observation.Exists {
					return fmt.Errorf("cleaning runtime resource is still present")
				}
				if err := provider.Clean(ctx, record.Handle, record.binding()); err != nil {
					return err
				}
				record.Handle = RuntimeHandle{}
			}
			if err := manager.store.removeGeneration(record.WorkspaceID, record.Generation); err != nil {
				return err
			}
			result = manager.result("reconcile", DispositionCleaned, record, nil)
			return manager.store.remove(record.WorkspaceID)
		case StateStopped, StateFailed, StateStale:
			// Terminal or explicitly ambiguous state: report it without guessing.
		}
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(record); err != nil {
			return err
		}
		result = manager.result("reconcile", DispositionCreated, record, nil)
		return nil
	})
	return result, err
}
