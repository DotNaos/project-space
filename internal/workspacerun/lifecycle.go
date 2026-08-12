package workspacerun

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

func (manager *Manager) Inspect(ctx context.Context, directory string, options OperationOptions) (Result, error) {
	plan, err := manager.resolve(ctx, directory, options, false)
	if err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "inspect", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	var result Result
	err = manager.store.withLock(plan.Identity.WorkspaceID, func() error {
		record, exists, err := manager.store.load(plan.Identity)
		if err != nil {
			return err
		}
		if !exists {
			record = emptyRecord(plan, StateStopped, manager.timestamp())
			result = manager.result("inspect", "", record, nil)
			return nil
		}
		if err := verifyGeneration(record, options.ExpectedGeneration); err != nil {
			result = manager.result("inspect", "", record, err)
			return err
		}
		if record.ManifestDigest != plan.Digest || record.Head != plan.Identity.Head || record.Directory != plan.Identity.Directory {
			err := fmt.Errorf("active runtime is bound to a different checkout HEAD or resolved manifest")
			result = manager.result("inspect", "", record, err)
			return err
		}
		if activeState(record.State) {
			provider, err := manager.provider(record.Mode)
			if err != nil {
				return err
			}
			if record.State == StateSuspended {
				err = manager.inspectSuspended(ctx, provider, record)
			} else {
				err = manager.inspectResources(ctx, provider, record)
			}
			if err != nil {
				result = manager.result("inspect", "", record, err)
				return err
			}
		}
		record.CheckedAt = manager.timestamp()
		record.LastError = ""
		if err := manager.store.save(record); err != nil {
			return err
		}
		result = manager.result("inspect", "", record, nil)
		return nil
	})
	return result, err
}

func (manager *Manager) Suspend(ctx context.Context, directory string, options OperationOptions) (Result, error) {
	if err := requireExpectedGeneration(options); err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "suspend", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	return manager.transition(ctx, "suspend", directory, options, func(plan resolvedPlan, record *runtimeRecord, provider RuntimeProvider) error {
		if record.State == StateSuspended {
			return manager.inspectSuspended(ctx, provider, *record)
		}
		if record.State != StateRunning {
			return fmt.Errorf("Workspace runtime must be running before suspend; current state is %s", record.State)
		}
		if !sameActivePlan(*record, plan) {
			return fmt.Errorf("Workspace runtime plan changed before suspend")
		}
		if err := manager.inspectResources(ctx, provider, *record); err != nil {
			return err
		}
		record.State = StateSuspending
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(*record); err != nil {
			return err
		}
		stopped, err := manager.stopServers(ctx, record)
		if err != nil {
			ledgerErr := manager.reconcileDevServerLedger(ctx, record)
			restartErr := error(nil)
			if ledgerErr == nil {
				restartErr = manager.restartServers(ctx, record, stopped)
			}
			if ledgerErr == nil && restartErr == nil {
				record.State = StateRunning
			} else {
				record.State = StateStale
			}
			return errors.Join(err, ledgerErr, restartErr)
		}
		if err := provider.Suspend(ctx, record.Handle, record.binding()); err != nil {
			restartErr := manager.restartServers(ctx, record, stopped)
			if restartErr == nil {
				record.State = StateRunning
			} else {
				record.State = StateStale
			}
			return errors.Join(err, restartErr)
		}
		record.DevServers = []ManagedDevServer{}
		record.State = StateSuspended
		return nil
	})
}

func (manager *Manager) Resume(ctx context.Context, directory string, options OperationOptions) (Result, error) {
	if err := requireExpectedGeneration(options); err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "resume", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	return manager.transition(ctx, "resume", directory, options, func(plan resolvedPlan, record *runtimeRecord, provider RuntimeProvider) error {
		if record.State == StateRunning {
			return manager.inspectResources(ctx, provider, *record)
		}
		if record.State != StateSuspended {
			return fmt.Errorf("Workspace runtime must be suspended before resume; current state is %s", record.State)
		}
		if !sameActivePlan(*record, plan) {
			return fmt.Errorf("Workspace runtime plan changed before resume")
		}
		if err := manager.inspectSuspended(ctx, provider, *record); err != nil {
			return err
		}
		record.State = StateResuming
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(*record); err != nil {
			return err
		}
		if err := provider.Resume(ctx, record.Handle, record.binding()); err != nil {
			record.State = StateSuspended
			return err
		}
		_, err := manager.startServers(ctx, record)
		if err != nil {
			ledgerErr := manager.reconcileDevServerLedger(ctx, record)
			var stopErr, suspendErr error
			if ledgerErr == nil {
				_, stopErr = manager.stopServers(ctx, record)
				if stopErr == nil {
					suspendErr = provider.Suspend(ctx, record.Handle, record.binding())
				}
			} else {
				record.State = StateStale
			}
			if ledgerErr == nil && stopErr == nil && suspendErr == nil {
				record.DevServers = []ManagedDevServer{}
				record.DevServerOperation = nil
				record.State = StateSuspended
			}
			return errors.Join(err, ledgerErr, stopErr, suspendErr)
		}
		record.State = StateRunning
		return manager.inspectResources(ctx, provider, *record)
	})
}

func (manager *Manager) Stop(ctx context.Context, directory string, options OperationOptions, streams Streams) (Result, error) {
	if err := requireExpectedGeneration(options); err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "stop", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	identity, err := manager.resolveIdentity(ctx, directory, options)
	if err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "stop", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
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
			result = manager.result("stop", "", record, err)
			return err
		}
		provider, err := manager.provider(record.Mode)
		if err != nil {
			return err
		}
		if record.State == StateStopped && len(record.DevServers) == 0 {
			if record.Handle.Kind != "" {
				observation, inspectErr := provider.Inspect(ctx, record.Handle, record.binding())
				if inspectErr != nil || observation.Exists {
					return errors.Join(inspectErr, fmt.Errorf("stopped runtime resource is still present or cannot be verified"))
				}
			}
			result = manager.result("stop", DispositionReused, record, nil)
			return nil
		}
		if err := manager.preflightOwned(ctx, provider, record); err != nil {
			result = manager.result("stop", "", record, err)
			return err
		}
		record.State = StateStopping
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(record); err != nil {
			return err
		}
		_, stopErr := manager.stopServers(ctx, &record)
		if stopErr == nil {
			stopErr = manager.syncRuntimeSessionState(record)
		}
		currentPlan, planErr := resolvePlan(ctx, manager.identity, record.Directory, record.Mode)
		if planErr == nil && sameActivePlan(record, currentPlan) {
			for _, command := range record.Shutdown {
				hookCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				runtimeEnvironment := generationEnvironment(manager.store.generationHome(record.WorkspaceID, record.Generation), record.binding())
				_, hookErr := manager.project.RunWithOptions(hookCtx, record.Directory, command, projectrun.Streams{Stdout: streams.Out, Stderr: streams.Err}, projectrun.RunOptions{Environment: runtimeEnvironment})
				cancel()
				stopErr = errors.Join(stopErr, hookErr)
			}
		}
		if record.Handle.Kind != "" {
			observation, inspectErr := provider.Inspect(ctx, record.Handle, record.binding())
			if inspectErr != nil || !observation.Exists || !observation.Owned {
				stopErr = errors.Join(stopErr, inspectErr, fmt.Errorf("runtime ownership changed immediately before stop"))
			} else {
				stopErr = errors.Join(stopErr, provider.Stop(ctx, record.Handle, record.binding(), 5*time.Second))
			}
		}
		if stopErr != nil {
			record.State = StateStale
			record.LastError = stopErr.Error()
			record.CheckedAt = manager.timestamp()
			_ = manager.store.save(record)
			result = manager.result("stop", "", record, stopErr)
			return stopErr
		}
		record.State = StateStopped
		record.DevServers = []ManagedDevServer{}
		record.CheckedAt = manager.timestamp()
		record.LastError = ""
		if err := manager.store.save(record); err != nil {
			return err
		}
		result = manager.result("stop", DispositionCreated, record, nil)
		return nil
	})
	return result, err
}

func (manager *Manager) Clean(ctx context.Context, directory string, options OperationOptions) (Result, error) {
	if err := requireExpectedGeneration(options); err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "clean", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	identity, err := manager.resolveIdentity(ctx, directory, options)
	if err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "clean", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
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
			return err
		}
		if activeState(record.State) || len(record.DevServers) > 0 || record.State != StateStopped && record.State != StateFailed {
			return fmt.Errorf("Workspace runtime must be fully stopped before clean")
		}
		if record.GenerationRemoved {
			result = manager.result("clean", DispositionCleaned, record, nil)
			return nil
		}
		provider, err := manager.provider(record.Mode)
		if err != nil {
			return err
		}
		if record.Handle.Kind != "" {
			observation, inspectErr := provider.Inspect(ctx, record.Handle, record.binding())
			if inspectErr != nil || observation.Exists {
				return errors.Join(inspectErr, fmt.Errorf("runtime resource absence could not be proven before clean"))
			}
		}
		record.State = StateCleaning
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(record); err != nil {
			return err
		}
		if record.Handle.Kind != "" {
			if err := provider.Clean(ctx, record.Handle, record.binding()); err != nil {
				return err
			}
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
		result = manager.result("clean", DispositionCleaned, record, nil)
		return nil
	})
	return result, err
}

func (manager *Manager) transition(
	ctx context.Context,
	operation string,
	directory string,
	options OperationOptions,
	action func(resolvedPlan, *runtimeRecord, RuntimeProvider) error,
) (Result, error) {
	plan, err := manager.resolve(ctx, directory, options, false)
	if err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: operation, CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	var result Result
	err = manager.store.withLock(plan.Identity.WorkspaceID, func() error {
		record, exists, err := manager.store.load(plan.Identity)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("Workspace runtime does not exist")
		}
		if err := verifyGeneration(record, options.ExpectedGeneration); err != nil {
			result = manager.result(operation, "", record, err)
			return err
		}
		provider, err := manager.provider(record.Mode)
		if err != nil {
			return err
		}
		if err := action(plan, &record, provider); err != nil {
			record.LastError = err.Error()
			record.CheckedAt = manager.timestamp()
			_ = manager.store.save(record)
			result = manager.result(operation, "", record, err)
			return err
		}
		if err := manager.syncRuntimeSessionState(record); err != nil {
			record.LastError = err.Error()
			record.CheckedAt = manager.timestamp()
			_ = manager.store.save(record)
			result = manager.result(operation, "", record, err)
			return err
		}
		record.LastError = ""
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(record); err != nil {
			return err
		}
		result = manager.result(operation, DispositionCreated, record, nil)
		return nil
	})
	return result, err
}

func (manager *Manager) resolveIdentity(ctx context.Context, directory string, options OperationOptions) (WorkspaceIdentity, error) {
	identity, err := manager.identity.Resolve(ctx, directory)
	if err != nil {
		return WorkspaceIdentity{}, err
	}
	if err := manager.checkout.Verify(ctx, identity, options); err != nil {
		return WorkspaceIdentity{}, err
	}
	if options.ExpectedWorkspaceID != "" && identity.WorkspaceID != options.ExpectedWorkspaceID {
		return WorkspaceIdentity{}, fmt.Errorf("Workspace identity mismatch")
	}
	return identity, nil
}

func (manager *Manager) inspectSuspended(ctx context.Context, provider RuntimeProvider, record runtimeRecord) error {
	if record.DevServerOperation != nil {
		return fmt.Errorf("suspended Workspace runtime has an interrupted dev-server operation")
	}
	observation, err := provider.Inspect(ctx, record.Handle, record.binding())
	if err != nil {
		return err
	}
	if !observation.Exists || !observation.Owned || !observation.Suspended || observation.Running || len(record.DevServers) != 0 {
		return fmt.Errorf("suspended Workspace runtime ownership is missing or still has active dev servers")
	}
	return nil
}

func (manager *Manager) preflightOwned(ctx context.Context, provider RuntimeProvider, record runtimeRecord) error {
	if record.DevServerOperation != nil {
		return fmt.Errorf("Workspace runtime has an interrupted dev-server operation; reconcile it first")
	}
	if record.Handle.Kind != "" {
		observation, err := provider.Inspect(ctx, record.Handle, record.binding())
		if err != nil {
			return err
		}
		if !observation.Exists {
			return fmt.Errorf("Workspace runtime resource is missing")
		}
		if !observation.Owned {
			return fmt.Errorf("Workspace runtime process ownership changed")
		}
	}
	for _, server := range record.DevServers {
		observed, err := manager.project.Status(ctx, record.Directory, server.Name)
		if err != nil {
			return err
		}
		if err := exactServer(record, observed, server); err != nil {
			return err
		}
	}
	return nil
}

func (manager *Manager) preflightCleanup(ctx context.Context, provider RuntimeProvider, record runtimeRecord) (ProviderObservation, error) {
	observation := ProviderObservation{}
	if record.Handle.Kind != "" {
		var err error
		observation, err = provider.Inspect(ctx, record.Handle, record.binding())
		if err != nil {
			return ProviderObservation{}, err
		}
		if observation.Exists && !observation.Owned {
			return ProviderObservation{}, fmt.Errorf("Workspace runtime process ownership changed")
		}
	}
	for _, server := range record.DevServers {
		observed, err := manager.project.Status(ctx, record.Directory, server.Name)
		if err != nil {
			return ProviderObservation{}, err
		}
		if err := exactServer(record, observed, server); err != nil {
			return ProviderObservation{}, err
		}
	}
	return observation, nil
}

func (manager *Manager) stopServers(ctx context.Context, record *runtimeRecord) ([]ManagedDevServer, error) {
	stopped := []ManagedDevServer{}
	for len(record.DevServers) > 0 {
		index := len(record.DevServers) - 1
		server := record.DevServers[index]
		observed, err := manager.project.Status(ctx, record.Directory, server.Name)
		if err != nil {
			return stopped, err
		}
		if err := exactServer(*record, observed, server); err != nil {
			return stopped, err
		}
		record.DevServerOperation = &devServerOperation{Name: server.Name, Action: devServerStopping}
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(*record); err != nil {
			return stopped, err
		}
		if _, err := manager.project.StopExpected(ctx, record.Directory, server.Name, record.WorkspaceID, record.Generation); err != nil {
			return stopped, err
		}
		stopped = append(stopped, server)
		record.DevServers = record.DevServers[:index]
		record.DevServerOperation = nil
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(*record); err != nil {
			return stopped, err
		}
	}
	return stopped, nil
}

func (manager *Manager) startServers(ctx context.Context, record *runtimeRecord) ([]ManagedDevServer, error) {
	return manager.startNamedServers(ctx, record, record.ExpectedDevServers)
}

func (manager *Manager) startNamedServers(ctx context.Context, record *runtimeRecord, names []string) ([]ManagedDevServer, error) {
	if record.DevServerOperation != nil {
		return nil, fmt.Errorf("cannot start a dev server while another dev-server operation is unresolved")
	}
	started := []ManagedDevServer{}
	for _, name := range names {
		record.DevServerOperation = &devServerOperation{Name: name, Action: devServerStarting}
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(*record); err != nil {
			return started, err
		}
		server, err := manager.project.StartWithOptions(ctx, record.Directory, name, projectrun.StartOptions{
			LocalOnly: true, APIs: projectrun.APIsModeSimulated, Data: projectrun.DataModeLocal,
			WorkspaceID: record.WorkspaceID, RuntimeGeneration: record.Generation,
			Environment: generationEnvironment(manager.store.generationHome(record.WorkspaceID, record.Generation), record.binding()),
		})
		if err != nil {
			return started, err
		}
		managed := serverFromResult(name, server)
		if err := exactServer(*record, server, managed); err != nil {
			return started, err
		}
		started = append(started, managed)
		record.DevServers = append(record.DevServers, managed)
		record.DevServerOperation = nil
		record.CheckedAt = manager.timestamp()
		if err := manager.store.save(*record); err != nil {
			return started, err
		}
	}
	return started, nil
}

func (manager *Manager) restartServers(ctx context.Context, record *runtimeRecord, _ []ManagedDevServer) error {
	present := make(map[string]bool, len(record.DevServers))
	for _, server := range record.DevServers {
		present[server.Name] = true
	}
	names := make([]string, 0, len(record.ExpectedDevServers)-len(record.DevServers))
	for _, name := range record.ExpectedDevServers {
		if !present[name] {
			names = append(names, name)
		}
	}
	_, err := manager.startNamedServers(ctx, record, names)
	return err
}

func emptyRecord(plan resolvedPlan, state RuntimeState, checkedAt string) runtimeRecord {
	return runtimeRecord{
		Version: SchemaVersion, WorkspaceID: plan.Identity.WorkspaceID,
		Repository: plan.Identity.Repository, Directory: plan.Identity.Directory,
		GitDirectory: plan.Identity.GitDirectory, Branch: plan.Identity.Branch, Head: plan.Identity.Head,
		IdentityProof: plan.Identity.IdentityProof, ManifestDigest: plan.Digest,
		Mode: plan.Mode, State: state, Resources: plan.Resolution.Manifest.Resources,
		DevServers: []ManagedDevServer{}, CheckedAt: checkedAt,
	}
}
