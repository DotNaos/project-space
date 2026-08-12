package workspacerun

import (
	"context"
	"errors"
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
		if record.State != StateCleaning && record.State != StateStopped && record.State != StateFailed {
			if err := manager.reconcileDevServerLedger(ctx, &record); err != nil {
				record.State = StateStale
				record.LastError = err.Error()
				record.CheckedAt = manager.timestamp()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, err)
				return err
			}
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
				if err := manager.cleanupOwned(ctx, provider, &record); err != nil {
					record.State = StateStale
					record.LastError = err.Error()
					_ = manager.store.save(record)
					result = manager.result("reconcile", "", record, err)
					return err
				}
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
			if record.Handle.Kind == "" && len(record.DevServers) == 0 {
				record.State = StateFailed
				record.LastError = "interrupted runtime transition ended before resource launch"
				break
			}
			observation, inspectErr := provider.Inspect(ctx, record.Handle, record.binding())
			if inspectErr != nil || (observation.Exists && !observation.Owned) {
				if inspectErr == nil {
					inspectErr = fmt.Errorf("runtime ownership changed")
				}
				record.State = StateStale
				record.LastError = inspectErr.Error()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, inspectErr)
				return inspectErr
			}
			if !observation.Exists {
				if len(record.DevServers) > 0 {
					if err := manager.cleanupOwned(ctx, provider, &record); err != nil {
						record.State = StateStale
						record.LastError = err.Error()
						_ = manager.store.save(record)
						result = manager.result("reconcile", "", record, err)
						return err
					}
				}
				record.State = StateFailed
				record.Handle = RuntimeHandle{}
				record.LastError = "interrupted runtime transition ended after its process exited"
				break
			}
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
			observation, inspectErr := provider.Inspect(ctx, record.Handle, record.binding())
			if inspectErr != nil || (observation.Exists && !observation.Owned) {
				return errors.Join(inspectErr, fmt.Errorf("stopping runtime ownership is ambiguous"))
			}
			if !observation.Exists {
				if len(record.DevServers) > 0 {
					if err := manager.cleanupOwned(ctx, provider, &record); err != nil {
						return err
					}
				}
				record.State = StateStopped
				record.Handle = RuntimeHandle{}
				record.LastError = ""
				break
			}
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
			archive, err := manager.store.removeGeneration(record.WorkspaceID, record.Generation, record.GenerationProof)
			if err != nil {
				return err
			}
			record.GenerationRemoved = true
			record.GenerationArchive = archive
			record.Handle = RuntimeHandle{}
			record.State = StateStopped
			record.CheckedAt = manager.timestamp()
			record.LastError = ""
			if err := manager.store.save(record); err != nil {
				return err
			}
			result = manager.result("reconcile", DispositionCleaned, record, nil)
			return nil
		case StateStale:
			if err := manager.cleanupOwned(ctx, provider, &record); err != nil {
				record.LastError = err.Error()
				_ = manager.store.save(record)
				result = manager.result("reconcile", "", record, err)
				return err
			}
			record.State = StateFailed
			record.Handle = RuntimeHandle{}
			record.DevServers = []ManagedDevServer{}
			record.DevServerOperation = nil
			record.LastError = "ambiguous runtime was reconciled to authoritative absence"
		case StateStopped, StateFailed:
			// Terminal state: report it without redispatch.
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
