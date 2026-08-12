package projectrun

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"time"
)

type Dependencies struct {
	Processes  ProcessRunner
	Tmux       TmuxManager
	Portless   LocalRouter
	Tailnet    Tailnet
	Prober     Prober
	Ports      PortAllocator
	StateRoot  string
	Now        Clock
	Repository RepositoryInspector
	Identity   ServerIdentityResolver
	Token      func() (string, error)
}

type Manager struct {
	processes  ProcessRunner
	tmux       TmuxManager
	portless   LocalRouter
	tailnet    Tailnet
	prober     Prober
	ports      PortAllocator
	store      *stateStore
	now        Clock
	repository RepositoryInspector
	identity   ServerIdentityResolver
	token      func() (string, error)
}

func NewDefaultManager() (*Manager, error) {
	root, err := defaultStateRoot()
	if err != nil {
		return nil, err
	}
	processes := OSProcessRunner{}
	return NewManager(Dependencies{
		Processes: processes,
		Tmux:      TmuxCLI{},
		Portless:  PortlessCLI{},
		Tailnet:   TailscaleCLI{},
		Prober:    NetworkProber{},
		Ports:     NetworkPortAllocator{},
		StateRoot: root,
		Now:       time.Now,
	})
}

func NewManager(dependencies Dependencies) (*Manager, error) {
	if dependencies.Processes == nil || dependencies.Portless == nil || dependencies.Tailnet == nil ||
		dependencies.Prober == nil || dependencies.Ports == nil {
		return nil, fmt.Errorf("project run dependencies must not be nil")
	}
	if dependencies.Now == nil {
		dependencies.Now = time.Now
	}
	if dependencies.Tmux == nil {
		dependencies.Tmux = TmuxCLI{}
	}
	if dependencies.Repository == nil {
		dependencies.Repository = GitRepositoryInspector{}
	}
	if dependencies.Identity == nil {
		dependencies.Identity = GitServerIdentityResolver{}
	}
	if dependencies.Token == nil {
		dependencies.Token = randomGeneration
	}
	store, err := newStateStore(dependencies.StateRoot)
	if err != nil {
		return nil, err
	}
	return &Manager{
		processes:  dependencies.Processes,
		tmux:       dependencies.Tmux,
		portless:   dependencies.Portless,
		tailnet:    dependencies.Tailnet,
		prober:     dependencies.Prober,
		ports:      dependencies.Ports,
		store:      store,
		now:        dependencies.Now,
		repository: dependencies.Repository,
		identity:   dependencies.Identity,
		token:      dependencies.Token,
	}, nil
}

func randomGeneration() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate serve ownership token: %w", err)
	}
	return hex.EncodeToString(value), nil
}

func (manager *Manager) Start(
	ctx context.Context,
	directory string,
	scriptName string,
	allowedHostValues []string,
) (ServeResult, error) {
	return manager.StartWithOptions(ctx, directory, scriptName, StartOptions{
		AllowedHosts: allowedHostValues,
		APIs:         APIsModeSimulated,
		Data:         DataModeLocal,
	})
}

func (manager *Manager) StartWithOptions(
	ctx context.Context,
	directory string,
	scriptName string,
	options StartOptions,
) (ServeResult, error) {
	if (options.WorkspaceID == "") != (options.RuntimeGeneration == "") {
		err := fmt.Errorf("workspace ID and runtime generation must be supplied together")
		return manager.runtimeErrorResult("start", directory, scriptName, err), err
	}
	requestedDirectory, err := absoluteDirectory(directory)
	if err != nil {
		return manager.configErrorResult("start", "", scriptName, err), err
	}
	root, script, err := LoadScript(directory, scriptName)
	if err != nil {
		return manager.configErrorResult("start", root, scriptName, err), err
	}
	identity, err := manager.identity.Resolve(ctx, root, scriptName)
	if err != nil {
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	apis := options.APIs
	if apis == "" {
		apis = APIsModeSimulated
	}
	data := options.Data
	if data == "" {
		data = DataModeLocal
	}
	if apis != APIsModeSimulated && apis != APIsModeExternal {
		err := fmt.Errorf("APIs mode %q is invalid", apis)
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	if data != DataModeLocal && data != DataModeRemote {
		err := fmt.Errorf("data mode %q is invalid", data)
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	if apis == APIsModeSimulated && data == DataModeRemote {
		err := fmt.Errorf("simulated APIs cannot use remote data")
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	if apis == APIsModeExternal {
		err := fmt.Errorf("external APIs are blocked until secure detached service-account delivery is configured")
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	mode := ServeModeManaged
	if options.LocalOnly {
		mode = ServeModeLocalOnly
	}
	allowedHosts, err := NormalizeAllowedHosts(options.AllowedHosts)
	if err != nil {
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	unlock, err := acquireFileLock(manager.store.sessionLockPath(identity.ServerID))
	if err != nil {
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return manager.runtimeErrorResult("start", root, scriptName, err), err
	}

	if existing, ok, loadErr := manager.store.load(identity); loadErr != nil {
		return manager.runtimeErrorResult("start", root, scriptName, loadErr), loadErr
	} else if ok {
		if existing.State == StateRunning || existing.State == StateLocalOnly {
			if healthErr := manager.checkRuntime(ctx, existing, script); healthErr == nil {
				if existing.WorkspaceID != options.WorkspaceID || existing.RuntimeGeneration != options.RuntimeGeneration {
					err := fmt.Errorf("serve session belongs to a different Workspace runtime generation; stop it through its owning runtime")
					return manager.resultFromState("start", CapabilityConfigured, existing, err), err
				}
				if existing.APIs != apis || existing.Data != data {
					err := fmt.Errorf(
						"serve session is already running with APIs=%s and data=%s; stop it before requesting APIs=%s and data=%s",
						existing.APIs, existing.Data, apis, data,
					)
					return manager.resultFromState("start", CapabilityConfigured, existing, err), err
				}
				if existing.Mode != mode {
					err := fmt.Errorf(
						"serve session is already running in %s mode; stop it before requesting %s mode",
						existing.Mode, mode,
					)
					return manager.resultFromState("start", CapabilityConfigured, existing, err), err
				}
				if !reflect.DeepEqual(existing.AllowedHosts, allowedHosts) {
					err := fmt.Errorf("serve session is already running with different allowed hosts; stop it first")
					return manager.resultFromState("start", CapabilityConfigured, existing, err), err
				}
				existing.CheckedAt = manager.timestamp()
				existing.LastError = ""
				_ = manager.store.save(existing)
				result := manager.resultFromState("start", CapabilityConfigured, existing, nil)
				result.Disposition = ServeDispositionReused
				return result, nil
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
	state, failure, err := manager.startLocalRuntime(
		startCtx, identity, requestedDirectory, mode, allowedHosts, script, root,
		apis, data, options.WorkspaceID, options.RuntimeGeneration,
		options.Environment,
	)
	if err != nil {
		return failure, err
	}
	if mode == ServeModeManaged {
		if err := manager.startTailnetTCP(startCtx, state.PublicPort, state.LocalPort); err != nil {
			return manager.failStart(state, err)
		}
		if err := manager.store.save(state); err != nil {
			return manager.failStart(state, err)
		}
		remote := ProbeTarget{Host: state.TailscaleIPv4, Port: state.PublicPort, Path: script.HealthPath()}
		if err := manager.prober.Wait(startCtx, remote, script.Timeout()); err != nil {
			return manager.failStart(state, fmt.Errorf("Tailscale URL did not become ready: %w", err))
		}
		state.State = StateRunning
	} else {
		state.State = StateLocalOnly
	}
	state.StartedAt = manager.timestamp()
	state.CheckedAt = state.StartedAt
	state.LastError = ""
	if err := manager.store.save(state); err != nil {
		return manager.failStart(state, err)
	}
	result := manager.resultFromState("start", CapabilityConfigured, state, nil)
	result.Disposition = ServeDispositionCreated
	return result, nil
}

func (manager *Manager) reserveSession(
	ctx context.Context,
	identity ServerIdentity,
	requestedDirectory string,
	mode ServeMode,
	allowedHosts []string,
	apis APIsMode,
	data DataMode,
	workspaceID string,
	runtimeGeneration string,
	environment []string,
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
	publicReserved := map[int]bool{}
	if mode == ServeModeManaged {
		publicReserved, err = manager.tailnet.OccupiedTCPPorts(ctx)
		if err != nil {
			return runtimeState{}, err
		}
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
	publicPort := 0
	address := ""
	if mode == ServeModeManaged {
		publicPort, err = manager.ports.Public(publicReserved)
		if err != nil {
			return runtimeState{}, err
		}
		address, err = manager.tailnet.IPv4(ctx)
		if err != nil {
			return runtimeState{}, err
		}
	}
	generation, err := manager.token()
	if err != nil {
		return runtimeState{}, err
	}
	ownershipToken, err := manager.token()
	if err != nil {
		return runtimeState{}, err
	}
	state := runtimeState{
		ServerID:           identity.ServerID,
		RepositoryPath:     identity.RepositoryPath,
		Directory:          identity.WorktreePath,
		RequestedDirectory: requestedDirectory,
		Script:             identity.ServerKey,
		Mode:               mode,
		APIs:               apis,
		Data:               data,
		State:              StateStarting,
		Generation:         generation,
		TmuxSession:        identity.TmuxSession,
		TmuxOwnershipToken: ownershipToken,
		WorkspaceID:        workspaceID,
		RuntimeGeneration:  runtimeGeneration,
		LocalPort:          localPort,
		PortlessName:       portlessName(identity),
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
	observation, err := manager.tmux.Inspect(ctx, state.TmuxSession)
	if err != nil {
		return transientRuntime(fmt.Errorf("inspect tmux session: %w", err))
	}
	if !observation.Exists {
		return fmt.Errorf("tmux session %q is not running", state.TmuxSession)
	}
	if !sameTmuxOwnership(observation.Spec, tmuxSpecFromState(state)) {
		return fmt.Errorf("tmux session %q ownership metadata does not match persisted state", state.TmuxSession)
	}
	process := observation.Process
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
	portlessMatches, err := manager.portless.Matches(
		ctx, state.PortlessName, state.PortlessURL, state.LocalPort,
	)
	if err != nil {
		return transientRuntime(fmt.Errorf("inspect Portless route: %w", err))
	}
	if !portlessMatches {
		return fmt.Errorf("Portless route %s no longer targets local port %d", state.PortlessURL, state.LocalPort)
	}
	if state.Mode == ServeModeManaged {
		routeMatches, err := manager.tailnet.MatchesTCP(ctx, state.PublicPort, state.LocalPort)
		if err != nil {
			return transientRuntime(fmt.Errorf("inspect Tailscale TCP route: %w", err))
		}
		if !routeMatches {
			return fmt.Errorf("Tailscale TCP port %d no longer targets local port %d", state.PublicPort, state.LocalPort)
		}
	}
	if err := manager.prober.Check(ctx, ProbeTarget{
		Host: "127.0.0.1", Port: state.LocalPort, Path: script.HealthPath(),
	}); err != nil {
		return transientRuntime(fmt.Errorf("local dev server health check failed: %w", err))
	}
	portlessTarget, err := probeTargetForURL(state.PortlessURL, script.HealthPath())
	if err != nil {
		return fmt.Errorf("Portless route is invalid: %w", err)
	}
	if err := manager.prober.Check(ctx, portlessTarget); err != nil {
		return transientRuntime(fmt.Errorf("Portless URL health check failed: %w", err))
	}
	if state.Mode == ServeModeManaged {
		if err := manager.prober.Check(ctx, ProbeTarget{
			Host: state.TailscaleIPv4, Port: state.PublicPort, Path: script.HealthPath(),
		}); err != nil {
			return transientRuntime(fmt.Errorf("Tailscale URL health check failed: %w", err))
		}
	}
	return nil
}

func (manager *Manager) cleanupRuntime(state runtimeState) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	observation, err := manager.tmux.Inspect(ctx, state.TmuxSession)
	if err != nil {
		return err
	}
	if observation.Exists && !sameTmuxOwnership(observation.Spec, tmuxSpecFromState(state)) {
		return fmt.Errorf("refusing cleanup because tmux session %q ownership changed", state.TmuxSession)
	}
	if !observation.Exists && state.PID > 0 && manager.processes.Alive(ProcessRef{PID: state.PID, Identity: state.ProcessID}) {
		return fmt.Errorf("refusing cleanup because recorded process %d is alive without its owned tmux session", state.PID)
	}
	var failures []error
	if state.PortlessURL != "" {
		if err := manager.stopPortlessRoute(ctx, state); err != nil {
			failures = append(failures, err)
		}
	}
	if state.Mode == ServeModeManaged && state.PublicPort > 0 {
		if err := manager.stopTailnetTCP(ctx, state.PublicPort, state.LocalPort); err != nil {
			failures = append(failures, err)
		}
	}
	if observation.Exists {
		if err := manager.tmux.Stop(ctx, tmuxSpecFromState(state)); err != nil {
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

func (manager *Manager) failStart(state runtimeState, cause error) (ServeResult, error) {
	cleanupErr := manager.cleanupRuntime(state)
	if cleanupErr != nil {
		cause = errors.Join(cause, fmt.Errorf("rollback failed: %w", cleanupErr))
	}
	state.State = StateError
	if cleanupErr == nil {
		state.PID, state.ProcessID = 0, ""
		state.LocalPort, state.PublicPort = 0, 0
		state.PortlessName, state.PortlessURL = "", ""
		state.TailscaleIPv4 = ""
	}
	state.StartedAt = ""
	state.CheckedAt = manager.timestamp()
	state.LastError = cause.Error()
	if tail := readRuntimeLogTail(manager.store.logPath(state.ServerID)); tail != "" {
		state.LastError += "\n\nStartup log tail:\n" + tail
		cause = errors.New(state.LastError)
	}
	if err := manager.store.save(state); err != nil {
		cause = errors.Join(cause, err)
	}
	return manager.resultFromState("start", CapabilityConfigured, state, cause), cause
}

func tmuxSpecFromState(state runtimeState) TmuxSessionSpec {
	return TmuxSessionSpec{
		Name: state.TmuxSession, ServerID: state.ServerID, RepositoryPath: state.RepositoryPath,
		WorktreePath: state.Directory, ServerKey: state.Script, Generation: state.Generation,
		OwnershipToken: state.TmuxOwnershipToken, Mode: state.Mode, APIs: state.APIs, Data: state.Data,
		WorkspaceID: state.WorkspaceID, RuntimeGeneration: state.RuntimeGeneration,
		LocalPort: state.LocalPort, PublicPort: state.PublicPort,
	}
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
