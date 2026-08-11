package projectrun

import (
	"context"
	"errors"
	"fmt"
)

const maximumPortRaceAttempts = 3

func (manager *Manager) startLocalRuntime(
	ctx context.Context,
	identity ServerIdentity,
	requestedDirectory string,
	mode ServeMode,
	allowedHosts []string,
	script Script,
	root string,
) (runtimeState, ServeResult, error) {
	for attempt := 1; attempt <= maximumPortRaceAttempts; attempt++ {
		state, err := manager.reserveSession(ctx, identity, requestedDirectory, mode, allowedHosts)
		if err != nil {
			return runtimeState{}, manager.runtimeErrorResult("start", root, identity.ServerKey, err), err
		}
		command := serverCommandFor(
			script, root, "127.0.0.1", state.LocalPort, allowedHosts, mode,
		)
		observation, err := manager.tmux.Create(
			ctx,
			tmuxSpecFromState(state),
			command,
			manager.store.requestPath(state.ServerID, state.Generation),
			manager.store.logPath(state.ServerID),
		)
		if err != nil {
			failure, failErr := manager.failStart(state, err)
			return runtimeState{}, failure, failErr
		}
		state.PID = observation.Process.PID
		state.ProcessID = observation.Process.Identity
		if err := manager.store.save(state); err != nil {
			failure, failErr := manager.failStart(state, err)
			return runtimeState{}, failure, failErr
		}
		local := ProbeTarget{Host: "127.0.0.1", Port: state.LocalPort, Path: script.HealthPath()}
		if err := manager.prober.Wait(ctx, local, script.Timeout()); err != nil {
			cause := fmt.Errorf("local dev server did not become ready: %w", err)
			owned, ownerErr := manager.processes.OwnsTCP(
				observation.Process, "127.0.0.1", state.LocalPort,
			)
			portOpen := false
			var inspectErr error
			if !owned {
				portOpen, inspectErr = manager.processes.TCPPortOpen(state.LocalPort)
			}
			if ownerErr != nil || inspectErr != nil {
				cause = errors.Join(cause, ownerErr, inspectErr)
			}
			failure, failErr := manager.failStart(state, cause)
			if ownerErr == nil && inspectErr == nil && !owned && portOpen &&
				attempt < maximumPortRaceAttempts &&
				failure.PID == nil && failure.LocalPort == nil {
				continue
			}
			return runtimeState{}, failure, failErr
		}
		observation, err = manager.tmux.Inspect(ctx, state.TmuxSession)
		if err != nil {
			failure, failErr := manager.failStart(state, err)
			return runtimeState{}, failure, failErr
		}
		if !observation.Exists || !sameTmuxOwnership(observation.Spec, tmuxSpecFromState(state)) {
			failure, failErr := manager.failStart(state, fmt.Errorf("tmux ownership changed during startup"))
			return runtimeState{}, failure, failErr
		}
		state.PID = observation.Process.PID
		state.ProcessID = observation.Process.Identity
		owner, err := manager.processes.OwnsTCP(observation.Process, "127.0.0.1", state.LocalPort)
		if err != nil {
			failure, failErr := manager.failStart(state, err)
			return runtimeState{}, failure, failErr
		}
		if !owner {
			cause := fmt.Errorf(
				"dev server process is not bound exclusively to 127.0.0.1:%d",
				state.LocalPort,
			)
			failure, failErr := manager.failStart(state, cause)
			if attempt < maximumPortRaceAttempts && failure.PID == nil && failure.LocalPort == nil {
				continue
			}
			return runtimeState{}, failure, failErr
		}
		return state, ServeResult{}, nil
	}
	panic("unreachable bounded port-race loop")
}
