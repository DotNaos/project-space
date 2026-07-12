package projectrun

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"
)

type Dependencies struct {
	Processes  ProcessRunner
	Tailnet    Tailnet
	Prober     Prober
	Ports      PortAllocator
	StateRoot  string
	Now        Clock
	Repository RepositoryInspector
}

type Manager struct {
	processes  ProcessRunner
	tailnet    Tailnet
	prober     Prober
	ports      PortAllocator
	store      *stateStore
	now        Clock
	repository RepositoryInspector
}

func NewDefaultManager() (*Manager, error) {
	root, err := defaultStateRoot()
	if err != nil {
		return nil, err
	}
	processes := OSProcessRunner{}
	return NewManager(Dependencies{
		Processes: processes,
		Tailnet:   TailscaleCLI{},
		Prober:    NetworkProber{},
		Ports:     NetworkPortAllocator{},
		StateRoot: root,
		Now:       time.Now,
	})
}

func NewManager(dependencies Dependencies) (*Manager, error) {
	if dependencies.Processes == nil || dependencies.Tailnet == nil ||
		dependencies.Prober == nil || dependencies.Ports == nil {
		return nil, fmt.Errorf("project run dependencies must not be nil")
	}
	if dependencies.Now == nil {
		dependencies.Now = time.Now
	}
	if dependencies.Repository == nil {
		dependencies.Repository = GitRepositoryInspector{}
	}
	store, err := newStateStore(dependencies.StateRoot)
	if err != nil {
		return nil, err
	}
	return &Manager{
		processes:  dependencies.Processes,
		tailnet:    dependencies.Tailnet,
		prober:     dependencies.Prober,
		ports:      dependencies.Ports,
		store:      store,
		now:        dependencies.Now,
		repository: dependencies.Repository,
	}, nil
}

func (manager *Manager) Start(
	ctx context.Context,
	directory string,
	scriptName string,
	allowedHostValues []string,
) (ServeResult, error) {
	requestedDirectory, err := absoluteDirectory(directory)
	if err != nil {
		return manager.configErrorResult("start", "", scriptName, err), err
	}
	root, script, err := LoadScript(directory, scriptName)
	if err != nil {
		return manager.configErrorResult("start", root, scriptName, err), err
	}
	allowedHosts, err := NormalizeAllowedHosts(allowedHostValues)
	if err != nil {
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	unlock, err := acquireFileLock(manager.store.sessionLockPath(root, scriptName))
	if err != nil {
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}

	if existing, ok, loadErr := manager.store.load(root, scriptName); loadErr != nil {
		return manager.runtimeErrorResult("start", root, scriptName, loadErr), loadErr
	} else if ok {
		if existing.State == StateRunning {
			if healthErr := manager.checkRuntime(ctx, existing, script); healthErr == nil {
				if !reflect.DeepEqual(existing.AllowedHosts, allowedHosts) {
					err := fmt.Errorf("serve session is already running with different allowed hosts; stop it first")
					return manager.resultFromState("start", CapabilityConfigured, existing, err), err
				}
				existing.CheckedAt = manager.timestamp()
				existing.LastError = ""
				_ = manager.store.save(existing)
				return manager.resultFromState("start", CapabilityConfigured, existing, nil), nil
			} else if isContextError(healthErr) {
				return manager.resultFromState("start", CapabilityConfigured, existing, healthErr), healthErr
			} else if isTransientRuntimeError(healthErr) {
				return manager.preserveRuntimeAfterTransientFailure(
					"start", CapabilityConfigured, existing, healthErr,
				)
			}
		}
		if cleanupErr := manager.cleanupRuntime(existing); cleanupErr != nil {
			existing.State = StateError
			existing.LastError = cleanupErr.Error()
			existing.CheckedAt = manager.timestamp()
			_ = manager.store.save(existing)
			return manager.resultFromState("start", CapabilityConfigured, existing, cleanupErr), cleanupErr
		}
	}

	startCtx, cancelStart := context.WithTimeout(ctx, script.Timeout())
	defer cancelStart()
	state, err := manager.reserveSession(startCtx, root, requestedDirectory, scriptName, allowedHosts)
	if err != nil {
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	command := commandFor(script, root, "127.0.0.1", state.LocalPort, allowedHosts)
	process, err := manager.processes.StartDetached(
		command,
		manager.store.logPath(root, scriptName),
		func(process ProcessRef) error {
			state.PID = process.PID
			state.ProcessID = process.Identity
			return manager.store.save(state)
		},
	)
	if err != nil {
		return manager.failStart(state, false, err)
	}
	local := ProbeTarget{Host: "127.0.0.1", Port: state.LocalPort, Path: script.HealthPath()}
	if err := manager.prober.Wait(startCtx, local, script.Timeout()); err != nil {
		return manager.failStart(state, false, fmt.Errorf("local dev server did not become ready: %w", err))
	}
	owner, err := manager.processes.OwnsTCP(process, "127.0.0.1", state.LocalPort)
	if err != nil {
		return manager.failStart(state, false, err)
	}
	if !owner {
		return manager.failStart(state, false, fmt.Errorf("dev server process is not bound exclusively to 127.0.0.1:%d", state.LocalPort))
	}
	if err := manager.startTailnetTCP(startCtx, state.PublicPort, state.LocalPort); err != nil {
		return manager.failStart(state, true, err)
	}
	if err := manager.store.save(state); err != nil {
		return manager.failStart(state, true, err)
	}
	remote := ProbeTarget{Host: state.TailscaleIPv4, Port: state.PublicPort, Path: script.HealthPath()}
	if err := manager.prober.Wait(startCtx, remote, script.Timeout()); err != nil {
		return manager.failStart(state, true, fmt.Errorf("Tailscale URL did not become ready: %w", err))
	}
	state.State = StateRunning
	state.StartedAt = manager.timestamp()
	state.CheckedAt = state.StartedAt
	state.LastError = ""
	if err := manager.store.save(state); err != nil {
		return manager.failStart(state, true, err)
	}
	return manager.resultFromState("start", CapabilityConfigured, state, nil), nil
}

func (manager *Manager) reserveSession(
	ctx context.Context,
	directory string,
	requestedDirectory string,
	script string,
	allowedHosts []string,
) (runtimeState, error) {
	unlock, err := acquireFileLock(manager.store.portLockPath())
	if err != nil {
		return runtimeState{}, err
	}
	defer unlock()
	listing, err := manager.store.list()
	if err != nil {
		return runtimeState{}, err
	}
	localReserved := map[int]bool{}
	publicReserved, err := manager.tailnet.OccupiedTCPPorts(ctx)
	if err != nil {
		return runtimeState{}, err
	}
	for _, state := range listing.States {
		if state.LocalPort > 0 {
			localReserved[state.LocalPort] = true
		}
		if state.PublicPort > 0 {
			publicReserved[state.PublicPort] = true
		}
	}
	localPort, err := manager.ports.Local(localReserved)
	if err != nil {
		return runtimeState{}, err
	}
	publicPort, err := manager.ports.Public(publicReserved)
	if err != nil {
		return runtimeState{}, err
	}
	address, err := manager.tailnet.IPv4(ctx)
	if err != nil {
		return runtimeState{}, err
	}
	state := runtimeState{
		Directory:          directory,
		RequestedDirectory: requestedDirectory,
		Script:             script,
		State:              StateStarting,
		LocalPort:          localPort,
		PublicPort:         publicPort,
		TailscaleIPv4:      address,
		AllowedHosts:       allowedHosts,
		CheckedAt:          manager.timestamp(),
	}
	if err := manager.store.save(state); err != nil {
		return runtimeState{}, err
	}
	return state, nil
}

func (manager *Manager) checkRuntime(ctx context.Context, state runtimeState, script Script) error {
	process := ProcessRef{PID: state.PID, Identity: state.ProcessID}
	if !manager.processes.Alive(process) {
		return fmt.Errorf("dev server process %d is not running", state.PID)
	}
	owner, err := manager.processes.OwnsTCP(process, "127.0.0.1", state.LocalPort)
	if err != nil {
		return transientRuntime(fmt.Errorf("inspect dev server port ownership: %w", err))
	}
	if !owner {
		return fmt.Errorf("dev server process does not own local port %d", state.LocalPort)
	}
	routeMatches, err := manager.tailnet.MatchesTCP(ctx, state.PublicPort, state.LocalPort)
	if err != nil {
		return transientRuntime(fmt.Errorf("inspect Tailscale TCP route: %w", err))
	}
	if !routeMatches {
		return fmt.Errorf("Tailscale TCP port %d no longer targets local port %d", state.PublicPort, state.LocalPort)
	}
	if err := manager.prober.Check(ctx, ProbeTarget{
		Host: "127.0.0.1", Port: state.LocalPort, Path: script.HealthPath(),
	}); err != nil {
		return transientRuntime(fmt.Errorf("local dev server health check failed: %w", err))
	}
	if err := manager.prober.Check(ctx, ProbeTarget{
		Host: state.TailscaleIPv4, Port: state.PublicPort, Path: script.HealthPath(),
	}); err != nil {
		return transientRuntime(fmt.Errorf("Tailscale URL health check failed: %w", err))
	}
	return nil
}

func (manager *Manager) cleanupRuntime(state runtimeState) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var failures []error
	if state.PublicPort > 0 {
		if err := manager.stopTailnetTCP(ctx, state.PublicPort, state.LocalPort); err != nil {
			failures = append(failures, err)
		}
	}
	if state.PID > 0 {
		if err := manager.processes.StopGroup(ProcessRef{
			PID: state.PID, Identity: state.ProcessID,
		}, 3*time.Second); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (manager *Manager) startTailnetTCP(ctx context.Context, publicPort, localPort int) error {
	unlock, err := acquireFileLock(manager.store.tailnetLockPath())
	if err != nil {
		return err
	}
	defer unlock()
	return manager.tailnet.StartTCP(ctx, publicPort, localPort)
}

func (manager *Manager) stopTailnetTCP(ctx context.Context, publicPort, localPort int) error {
	unlock, err := acquireFileLock(manager.store.tailnetLockPath())
	if err != nil {
		return err
	}
	defer unlock()
	return manager.tailnet.StopTCP(ctx, publicPort, localPort)
}

func (manager *Manager) failStart(
	state runtimeState,
	routeAttempted bool,
	cause error,
) (ServeResult, error) {
	rollback := runtimeState{
		PID: state.PID, ProcessID: state.ProcessID, LocalPort: state.LocalPort,
	}
	if routeAttempted {
		rollback.PublicPort = state.PublicPort
	}
	cleanupErr := manager.cleanupRuntime(rollback)
	if cleanupErr != nil {
		cause = errors.Join(cause, fmt.Errorf("rollback failed: %w", cleanupErr))
	}
	state.State = StateError
	if cleanupErr == nil {
		state.PID, state.ProcessID = 0, ""
		state.LocalPort, state.PublicPort = 0, 0
		state.TailscaleIPv4 = ""
	}
	state.StartedAt = ""
	state.CheckedAt = manager.timestamp()
	state.LastError = cause.Error()
	if tail := readRuntimeLogTail(manager.store.logPath(state.Directory, state.Script)); tail != "" {
		state.LastError += "\n\nStartup log tail:\n" + tail
		cause = errors.New(state.LastError)
	}
	if err := manager.store.save(state); err != nil {
		cause = errors.Join(cause, err)
	}
	return manager.resultFromState("start", CapabilityConfigured, state, cause), cause
}

type transientRuntimeError struct {
	cause error
}

func (failure transientRuntimeError) Error() string {
	return failure.cause.Error()
}

func (failure transientRuntimeError) Unwrap() error {
	return failure.cause
}

func transientRuntime(err error) error {
	return transientRuntimeError{cause: err}
}

func isTransientRuntimeError(err error) bool {
	failure := transientRuntimeError{}
	return errors.As(err, &failure)
}

func (manager *Manager) preserveRuntimeAfterTransientFailure(
	operation string,
	capability Capability,
	state runtimeState,
	cause error,
) (ServeResult, error) {
	state.LastError = cause.Error()
	if err := manager.store.save(state); err != nil {
		cause = errors.Join(cause, fmt.Errorf("record transient runtime failure: %w", err))
	}
	observed := state
	clearRuntimeResources(&observed)
	observed.State = StateError
	observed.CheckedAt = manager.timestamp()
	observed.LastError = cause.Error()
	return manager.resultFromState(operation, capability, observed, cause), cause
}

func isContextError(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func (manager *Manager) timestamp() string {
	return manager.now().UTC().Format(time.RFC3339Nano)
}
