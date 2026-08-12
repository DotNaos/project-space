package projectrun

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

type GitRepositoryInspector struct{}

func (GitRepositoryInspector) Head(ctx context.Context, directory string) (string, error) {
	command := exec.CommandContext(ctx, "git", "-C", directory, "rev-parse", "--verify", "HEAD")
	command.Env = safeEnvironment(os.Environ())
	body, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("read repository HEAD: %w", err)
	}
	head := strings.TrimSpace(string(body))
	if len(head) != 40 && len(head) != 64 {
		return "", fmt.Errorf("repository HEAD is not a full object ID")
	}
	for _, character := range head {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return "", fmt.Errorf("repository HEAD is not a lowercase hexadecimal object ID")
		}
	}
	return head, nil
}

func (manager *Manager) Prepare(
	ctx context.Context,
	directory string,
	stepID string,
	streams Streams,
) (SetupCollectionResult, error) {
	return manager.PrepareExpected(ctx, directory, stepID, SetupExpectations{}, streams)
}

func (manager *Manager) PrepareExpected(
	ctx context.Context,
	directory string,
	stepID string,
	expected SetupExpectations,
	streams Streams,
) (SetupCollectionResult, error) {
	declaration, head, result, err := manager.setupInputs(ctx, "prepare", directory)
	if err != nil {
		return result, err
	}
	names, err := selectedSetupNames(declaration, stepID)
	if err != nil {
		result.LastError = pointer(err.Error())
		return result, err
	}
	for index, name := range names {
		stepResult, stepErr := manager.prepareStep(ctx, declaration, head, name, expected, streams)
		result.Steps = append(result.Steps, stepResult)
		if stepErr != nil {
			result.LastError = pointer(stepErr.Error())
			for _, remaining := range names[index+1:] {
				status, statusErr := manager.setupStatusFor(declaration, head, remaining, "prepare")
				if statusErr != nil && result.LastError == nil {
					result.LastError = pointer(statusErr.Error())
				}
				result.Steps = append(result.Steps, status)
			}
			return result, stepErr
		}
	}
	result.CheckedAt = manager.timestamp()
	return result, nil
}

func (manager *Manager) SetupStatus(
	ctx context.Context,
	directory string,
	stepID string,
) (SetupCollectionResult, error) {
	declaration, head, result, err := manager.setupInputs(ctx, "status", directory)
	if err != nil {
		return result, err
	}
	names, err := selectedSetupNames(declaration, stepID)
	if err != nil {
		result.LastError = pointer(err.Error())
		return result, err
	}
	for _, name := range names {
		status, statusErr := manager.setupStatusFor(declaration, head, name, "status")
		result.Steps = append(result.Steps, status)
		if statusErr != nil && err == nil {
			err = statusErr
			result.LastError = pointer(statusErr.Error())
		}
	}
	result.CheckedAt = manager.timestamp()
	return result, err
}

func (manager *Manager) setupInputs(
	ctx context.Context,
	operation string,
	directory string,
) (Declaration, string, SetupCollectionResult, error) {
	declaration, err := LoadDeclaration(directory)
	result := SetupCollectionResult{
		SchemaVersion: SchemaVersion,
		Operation:     operation,
		Directory:     declaration.Root,
		Capability:    CapabilityConfigured,
		Steps:         []SetupResult{},
		CheckedAt:     manager.timestamp(),
	}
	if err != nil {
		result.Capability = CapabilityUnavailable
		result.LastError = pointer(err.Error())
		return declaration, "", result, err
	}
	if len(declaration.Setup) == 0 {
		err := fmt.Errorf("%w: %s has no setup steps", ErrSetupNotFound, scriptsConfigPath)
		result.Capability = CapabilityUnavailable
		result.LastError = pointer(err.Error())
		return declaration, "", result, err
	}
	head, err := manager.repository.Head(ctx, declaration.Root)
	if err != nil {
		result.LastError = pointer(err.Error())
		return declaration, "", result, err
	}
	return declaration, head, result, nil
}

func selectedSetupNames(declaration Declaration, requested string) ([]string, error) {
	if requested == "" {
		return declaration.SetupNames(), nil
	}
	if err := ValidateDeclarationName("setup step", requested); err != nil {
		return nil, err
	}
	if _, err := declaration.SetupStep(requested); err != nil {
		return nil, err
	}
	return []string{requested}, nil
}

func (manager *Manager) prepareStep(
	ctx context.Context,
	declaration Declaration,
	head string,
	stepID string,
	expected SetupExpectations,
	streams Streams,
) (SetupResult, error) {
	unlock, err := acquireFileLock(manager.store.setupLockPath(declaration.Root, stepID))
	if err != nil {
		return manager.setupErrorResult("prepare", declaration, head, stepID, err), err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return manager.setupErrorResult("prepare", declaration, head, stepID, err), err
	}
	if expected.Commit != "" || expected.DeclarationDigest != "" {
		latest, latestErr := LoadDeclaration(declaration.Root)
		latestHead, headErr := manager.repository.Head(ctx, declaration.Root)
		if latestErr != nil || headErr != nil {
			err := errors.Join(latestErr, headErr)
			return manager.setupErrorResult("prepare", declaration, head, stepID, err), err
		}
		if latestHead != expected.Commit || latest.Digest != expected.DeclarationDigest {
			err := errors.New("repository commit or setup declaration does not match the approved setup identity")
			return manager.setupErrorResult("prepare", latest, latestHead, stepID, err), err
		}
		// Use the declaration that was verified under the setup lock. This keeps
		// command selection and execution in one trusted CLI operation.
		declaration, head = latest, latestHead
	}
	current, statusErr := manager.setupStatusFor(declaration, head, stepID, "prepare")
	if statusErr != nil {
		return current, statusErr
	}
	if current.State == SetupReady || current.State == SetupRunning {
		return current, nil
	}
	step, err := declaration.SetupStep(stepID)
	if err != nil {
		return manager.setupErrorResult("prepare", declaration, head, stepID, err), err
	}
	log, err := openBoundedSetupLog(manager.store.setupLogPath(declaration.Root, stepID))
	if err != nil {
		return manager.setupErrorResult("prepare", declaration, head, stepID, err), err
	}
	startedAt := manager.timestamp()
	state := setupRuntimeState{
		Directory: declaration.Root, StepID: stepID, State: SetupRunning,
		Commit: head, DeclarationDigest: declaration.Digest,
		StartedAt: startedAt, CheckedAt: startedAt,
	}
	command := Command{Argv: append([]string{}, step.Command...), Dir: declaration.Root, Env: append([]string{}, expected.Environment...)}
	exitCode, runErr := manager.processes.RunForeground(
		ctx,
		command,
		setupStreams(streams, log),
		func(process ProcessRef) error {
			state.PID = process.PID
			state.ProcessIdentity = process.Identity
			return manager.store.saveSetup(state)
		},
	)
	if closeErr := log.Close(); closeErr != nil {
		runErr = errors.Join(runErr, closeErr)
	}
	finishedAt := manager.timestamp()
	state.PID, state.ProcessIdentity = 0, ""
	state.FinishedAt, state.CheckedAt = finishedAt, finishedAt
	var outcomeErr error
	switch {
	case isContextError(runErr):
		state.State = SetupInterrupted
		state.LastError = runErr.Error()
		outcomeErr = runErr
	case runErr != nil || exitCode != 0:
		state.State = SetupFailed
		if runErr != nil {
			state.LastError = runErr.Error()
			outcomeErr = runErr
		} else {
			state.LastError = fmt.Sprintf("setup command exited with code %d", exitCode)
			outcomeErr = errors.New(state.LastError)
		}
	default:
		latest, latestErr := LoadDeclaration(declaration.Root)
		latestHead, headErr := manager.repository.Head(ctx, declaration.Root)
		if latestErr != nil || headErr != nil {
			state.State = SetupFailed
			outcomeErr = errors.Join(latestErr, headErr)
			state.LastError = outcomeErr.Error()
		} else if latest.Digest != declaration.Digest || latestHead != head {
			state.State = SetupStale
			state.LastError = "repository commit or setup declaration changed while setup was running"
			outcomeErr = errors.New(state.LastError)
		} else {
			state.State = SetupReady
		}
	}
	if err := manager.store.saveSetup(state); err != nil {
		return manager.setupResult("prepare", CapabilityConfigured, state, err), err
	}
	result := manager.setupResult("prepare", CapabilityConfigured, state, nil)
	if state.State != SetupReady {
		return result, outcomeErr
	}
	return result, nil
}

func (manager *Manager) setupStatusFor(
	declaration Declaration,
	head string,
	stepID string,
	operation string,
) (SetupResult, error) {
	state, exists, err := manager.store.loadSetup(declaration.Root, stepID)
	if err != nil {
		return manager.setupErrorResult(operation, declaration, head, stepID, err), err
	}
	if !exists {
		return manager.setupResult(operation, CapabilityConfigured, setupRuntimeState{
			Directory: declaration.Root, StepID: stepID, State: SetupRequired,
			Commit: head, DeclarationDigest: declaration.Digest, CheckedAt: manager.timestamp(),
		}, nil), nil
	}
	if state.State == SetupRunning {
		process := ProcessRef{PID: state.PID, Identity: state.ProcessIdentity}
		if state.PID <= 0 || !manager.processes.Alive(process) {
			state.State = SetupInterrupted
			state.PID, state.ProcessIdentity = 0, ""
			state.FinishedAt, state.CheckedAt = manager.timestamp(), manager.timestamp()
			state.LastError = "setup process ended before recording a result"
			if err := manager.store.saveSetup(state); err != nil {
				return manager.setupResult(operation, CapabilityConfigured, state, err), err
			}
		}
	}
	if state.State != SetupRunning && (state.Commit != head || state.DeclarationDigest != declaration.Digest) {
		state.State = SetupStale
		state.CheckedAt = manager.timestamp()
		state.LastError = "repository commit or setup declaration changed"
		if err := manager.store.saveSetup(state); err != nil {
			return manager.setupResult(operation, CapabilityConfigured, state, err), err
		}
	}
	return manager.setupResult(operation, CapabilityConfigured, state, nil), nil
}

func (manager *Manager) setupResult(
	operation string,
	capability Capability,
	state setupRuntimeState,
	cause error,
) SetupResult {
	result := SetupResult{
		SchemaVersion: SchemaVersion, Operation: operation, StepID: state.StepID,
		Directory: state.Directory, Capability: capability, State: state.State,
		Commit: state.Commit, DeclarationDigest: state.DeclarationDigest,
		CheckedAt: state.CheckedAt,
	}
	if state.StartedAt != "" {
		result.StartedAt = pointer(state.StartedAt)
	}
	if state.FinishedAt != "" {
		result.FinishedAt = pointer(state.FinishedAt)
	}
	if cause != nil {
		result.LastError = pointer(cause.Error())
	} else if state.LastError != "" {
		result.LastError = pointer(state.LastError)
	}
	return result
}

func (manager *Manager) setupErrorResult(
	operation string,
	declaration Declaration,
	head string,
	stepID string,
	cause error,
) SetupResult {
	return manager.setupResult(operation, CapabilityConfigured, setupRuntimeState{
		Directory: declaration.Root, StepID: stepID, State: SetupFailed,
		Commit: head, DeclarationDigest: declaration.Digest, CheckedAt: manager.timestamp(),
	}, cause)
}

func ValidateDeclarationName(kind, name string) error {
	if !declarationPattern.MatchString(name) {
		return fmt.Errorf("%s name %q is invalid", kind, name)
	}
	return nil
}

func ListServers(directory string, now Clock) (ServerDeclarationCollectionResult, error) {
	if now == nil {
		now = func() time.Time { return time.Now() }
	}
	checkedAt := now().UTC().Format(time.RFC3339Nano)
	declaration, err := LoadDeclaration(directory)
	result := ServerDeclarationCollectionResult{
		SchemaVersion: SchemaVersion, Operation: "list", Directory: declaration.Root,
		Capability: CapabilityConfigured, Servers: []ServerDeclarationResult{}, CheckedAt: checkedAt,
	}
	if err != nil {
		result.Capability = CapabilityUnavailable
		result.LastError = pointer(err.Error())
		return result, err
	}
	ids := make([]string, 0, len(declaration.Server))
	for id := range declaration.Server {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		label := declaration.Server[id].Label
		if label == "" {
			label = id
		}
		result.Servers = append(result.Servers, ServerDeclarationResult{
			ServerID: id, Label: label, Capability: CapabilityConfigured,
		})
	}
	return result, nil
}
