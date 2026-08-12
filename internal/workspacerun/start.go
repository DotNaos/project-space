package workspacerun

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

func (manager *Manager) Start(
	ctx context.Context,
	directory string,
	options OperationOptions,
	streams Streams,
) (Result, error) {
	initial, err := manager.resolve(ctx, directory, options, true)
	if err != nil {
		return Result{SchemaVersion: SchemaVersion, Operation: "start", CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error())}, err
	}
	var result Result
	err = manager.store.withLock(initial.Identity.WorkspaceID, func() error {
		plan, err := manager.resolve(ctx, directory, options, true)
		if err != nil {
			return err
		}
		if plan.Identity.WorkspaceID != initial.Identity.WorkspaceID || plan.Digest != initial.Digest {
			return fmt.Errorf("Workspace identity or resolved plan changed while acquiring the runtime lock")
		}
		provider, err := manager.provider(plan.Mode)
		if err != nil {
			return err
		}
		existing, exists, err := manager.store.load(plan.Identity)
		if err != nil {
			return err
		}
		if exists && activeState(existing.State) {
			if err := verifyGeneration(existing, options.ExpectedGeneration); err != nil {
				result = manager.result("start", "", existing, err)
				return err
			}
			if !sameActivePlan(existing, plan) {
				err := fmt.Errorf("a different Workspace runtime is active; stop its exact generation first")
				result = manager.result("start", "", existing, err)
				return err
			}
			if existing.State != StateRunning {
				err := fmt.Errorf("Workspace runtime generation %s is %s, not reusable", existing.Generation, existing.State)
				result = manager.result("start", "", existing, err)
				return err
			}
			if err := manager.inspectResources(ctx, provider, existing); err != nil {
				result = manager.result("start", "", existing, err)
				return err
			}
			existing.CheckedAt = manager.timestamp()
			existing.LastError = ""
			if err := manager.store.save(existing); err != nil {
				return err
			}
			result = manager.result("start", DispositionReused, existing, nil)
			return nil
		}
		if exists && existing.State == StateStale {
			err := fmt.Errorf("stale Workspace runtime must be reconciled without replacing its ownership evidence")
			result = manager.result("start", "", existing, err)
			return err
		}
		if exists && (existing.Handle.Kind != "" || existing.Handle.Process != nil || existing.Handle.Container != nil || len(existing.DevServers) > 0) {
			err := fmt.Errorf("previous Workspace runtime still retains resource ownership evidence")
			result = manager.result("start", "", existing, err)
			return err
		}
		verified, err := manager.verifier.Verify(ctx, plan.Resolution.Manifest)
		if err != nil {
			return err
		}
		generation := options.ExpectedGeneration
		if generation == "" {
			generation, err = manager.token()
			if err != nil {
				return err
			}
		} else if !uuidPattern.MatchString(generation) {
			return fmt.Errorf("requested Workspace runtime generation is invalid")
		}
		ownershipToken, err := manager.token()
		if err != nil {
			return err
		}
		record := runtimeRecord{
			Version: SchemaVersion, WorkspaceID: plan.Identity.WorkspaceID,
			Repository: plan.Identity.Repository, Directory: plan.Identity.Directory,
			GitDirectory: plan.Identity.GitDirectory, Branch: plan.Identity.Branch, Head: plan.Identity.Head,
			IdentityProof: plan.Identity.IdentityProof, ManifestDigest: plan.Digest,
			Mode: plan.Mode, State: StateStarting, Generation: generation, OwnershipToken: ownershipToken,
			Resources:          plan.Resolution.Manifest.Resources,
			ExpectedDevServers: append([]string{}, plan.Resolution.Manifest.DevServers...),
			Shutdown:           append([]string{}, plan.Resolution.Manifest.Shutdown...),
			DevServers:         []ManagedDevServer{}, CheckedAt: manager.timestamp(),
		}
		if exists && !existing.GenerationRemoved {
			return fmt.Errorf("previous terminal Workspace runtime must be cleaned before recreation")
		}
		generationProof, err := manager.store.prepareGeneration(record.WorkspaceID, record.Generation)
		if err != nil {
			return err
		}
		record.GenerationProof = generationProof
		if err := manager.store.save(record); err != nil {
			return err
		}
		projectStreams := projectrun.Streams{Stdout: streams.Out, Stderr: streams.Err}
		runtimeEnvironment := generationEnvironment(manager.store.generationHome(record.WorkspaceID, record.Generation), record.binding())
		for _, step := range plan.Resolution.Manifest.Setup {
			if _, err := manager.project.PrepareExpected(ctx, plan.Identity.Directory, step, projectrun.SetupExpectations{
				Commit: plan.Identity.Head, DeclarationDigest: plan.Declaration.Digest, Environment: runtimeEnvironment,
			}, projectStreams); err != nil {
				return manager.failStart(ctx, provider, &record, err, &result)
			}
		}
		for _, command := range plan.Resolution.Manifest.Startup {
			if _, err := manager.project.RunWithOptions(ctx, plan.Identity.Directory, command, projectStreams, projectrun.RunOptions{Environment: runtimeEnvironment}); err != nil {
				return manager.failStart(ctx, provider, &record, err, &result)
			}
		}
		logFile, err := manager.store.openLog(record)
		if err != nil {
			return manager.failStart(ctx, provider, &record, err, &result)
		}
		handle, startErr := provider.Start(ctx, LaunchRequest{
			Workspace: plan.Identity, Binding: record.binding(), Directory: plan.Identity.Directory,
			Manifest: plan.Resolution.Manifest, ProjectBinary: verified.ProjectBinary,
			CodexBinary:    verified.CodexBinary,
			LogFile:        logFile,
			RuntimeSession: options.RuntimeSession,
			GenerationHome: manager.store.generationHome(record.WorkspaceID, record.Generation),
			Commit: func(handle RuntimeHandle) error {
				record.Handle = handle
				record.CheckedAt = manager.timestamp()
				return manager.store.save(record)
			},
		})
		_ = logFile.Close()
		if startErr != nil {
			return manager.failStart(ctx, provider, &record, startErr, &result)
		}
		record.Handle = handle
		if err := manager.store.save(record); err != nil {
			return manager.failStart(ctx, provider, &record, err, &result)
		}
		if _, err := manager.startServers(ctx, &record); err != nil {
			return manager.failStart(ctx, provider, &record, err, &result)
		}
		if err := manager.inspectResources(ctx, provider, record); err != nil {
			return manager.failStart(ctx, provider, &record, err, &result)
		}
		record.State = StateRunning
		record.StartedAt = manager.timestamp()
		record.CheckedAt = record.StartedAt
		record.LastError = ""
		if err := manager.store.save(record); err != nil {
			return manager.failStart(ctx, provider, &record, err, &result)
		}
		if options.RuntimeSession != nil {
			if err := manager.writeRuntimeSessionState(record); err != nil {
				return manager.failStart(ctx, provider, &record, err, &result)
			}
			if err := manager.publishRuntimeSessionReady(record); err != nil {
				return manager.failStart(ctx, provider, &record, err, &result)
			}
		}
		result = manager.result("start", DispositionCreated, record, nil)
		return nil
	})
	if err != nil && result.Operation == "" {
		result = Result{SchemaVersion: SchemaVersion, Operation: "start", WorkspaceID: initial.Identity.WorkspaceID,
			Directory: initial.Identity.Directory, Repository: initial.Identity.Repository, ManifestDigest: initial.Digest,
			SourceHead: initial.Identity.Head, Mode: initial.Mode, State: StateFailed, CheckedAt: manager.timestamp(), LastError: valuePointer(err.Error()), DevServers: []ManagedDevServer{}}
	}
	return result, err
}

func (manager *Manager) inspectResources(ctx context.Context, provider RuntimeProvider, record runtimeRecord) error {
	if record.DevServerOperation != nil {
		return fmt.Errorf("Workspace runtime has an interrupted dev-server operation; reconcile it first")
	}
	observation, err := provider.Inspect(ctx, record.Handle, record.binding())
	if err != nil {
		return err
	}
	if !observation.Exists || !observation.Owned || !observation.Running {
		return fmt.Errorf("Workspace runtime process ownership is missing or changed")
	}
	if len(record.DevServers) != len(record.ExpectedDevServers) {
		return fmt.Errorf("Workspace runtime has %d of %d expected dev servers", len(record.DevServers), len(record.ExpectedDevServers))
	}
	for index, expected := range record.DevServers {
		if expected.Name != record.ExpectedDevServers[index] {
			return fmt.Errorf("Workspace runtime dev-server order changed")
		}
		observed, err := manager.project.Status(ctx, record.Directory, expected.Name)
		if err != nil {
			return err
		}
		if err := exactServer(record, observed, expected); err != nil {
			return err
		}
	}
	return nil
}

func (manager *Manager) failStart(ctx context.Context, provider RuntimeProvider, record *runtimeRecord, cause error, result *Result) error {
	ledgerErr := manager.reconcileDevServerLedger(ctx, record)
	var cleanupErr error
	if ledgerErr == nil {
		cleanupErr = manager.cleanupOwned(ctx, provider, record)
	}
	combined := errors.Join(cause, ledgerErr, cleanupErr)
	if ledgerErr == nil && cleanupErr == nil {
		record.State = StateFailed
		record.Handle = RuntimeHandle{}
		record.DevServers = []ManagedDevServer{}
	} else {
		record.State = StateStale
	}
	record.CheckedAt = manager.timestamp()
	record.LastError = combined.Error()
	_ = manager.store.save(*record)
	*result = manager.result("start", "", *record, combined)
	return combined
}

func (manager *Manager) cleanupOwned(ctx context.Context, provider RuntimeProvider, record *runtimeRecord) error {
	if record.DevServerOperation != nil {
		return fmt.Errorf("Workspace runtime has an unresolved dev-server operation; reconcile it before cleanup")
	}
	observation, err := manager.preflightCleanup(ctx, provider, *record)
	if err != nil {
		return err
	}
	_, stopErr := manager.stopServers(ctx, record)
	if stopErr != nil {
		return stopErr
	}
	if record.Handle.Kind != "" && observation.Exists {
		current, inspectErr := provider.Inspect(ctx, record.Handle, record.binding())
		if inspectErr != nil || !current.Exists || !current.Owned {
			return errors.Join(inspectErr, fmt.Errorf("runtime ownership changed immediately before cleanup"))
		}
		if err := provider.Stop(ctx, record.Handle, record.binding(), 5*time.Second); err != nil {
			return err
		}
	}
	record.Handle = RuntimeHandle{}
	return nil
}
