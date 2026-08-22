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
	apis APIsMode,
	data DataMode,
	workspaceID string,
	runtimeGeneration string,
	environment []string,
	reviewTaskID string,
	reviewHostname string,
) (runtimeState, ServeResult, error) {
	for attempt := 1; attempt <= maximumPortRaceAttempts; attempt++ {
		state, err := manager.reserveSession(
			ctx, identity, requestedDirectory, mode, allowedHosts, apis, data, workspaceID,
			runtimeGeneration, environment, reviewTaskID,
		)
		if err != nil {
			generation, generationErr := manager.token()
			ownershipToken, ownershipErr := manager.token()
			if generationErr != nil || ownershipErr != nil {
				err = errors.Join(err, generationErr, ownershipErr)
			}
			failedState := runtimeState{
				ServerID:           identity.ServerID,
				RepositoryPath:     identity.RepositoryPath,
				Directory:          identity.WorktreePath,
				RequestedDirectory: requestedDirectory,
				Script:             identity.ServerKey,
				Mode:               mode,
				APIs:               apis,
				Data:               data,
				State:              StateError,
				Generation:         generation,
				TmuxSession:        identity.TmuxSession,
				TmuxOwnershipToken: ownershipToken,
				WorkspaceID:        workspaceID,
				RuntimeGeneration:  runtimeGeneration,
				ReviewTaskID:       reviewTaskID,
				AllowedHosts:       append([]string{}, allowedHosts...),
				CheckedAt:          manager.timestamp(),
				LastError:          err.Error(),
			}
			if generationErr == nil && ownershipErr == nil {
				if saveErr := manager.store.save(failedState); saveErr != nil {
					err = errors.Join(err, fmt.Errorf("persist failed serve preflight: %w", saveErr))
				}
			}
			failure := manager.resultFromState("start", CapabilityConfigured, failedState, err)
			return runtimeState{}, failure, err
		}
		state.PortlessURL, err = manager.startPortlessRoute(ctx, state)
		if err != nil {
			failure, failErr := manager.failStart(state, err)
			return runtimeState{}, failure, failErr
		}
		if err := manager.store.save(state); err != nil {
			failure, failErr := manager.failStart(state, err)
			return runtimeState{}, failure, failErr
		}
		runtimeAccessURL := state.PortlessURL
		if mode == ServeModeManaged && reviewHostname != "" {
			runtimeAccessURL = "https://" + reviewHostname
		} else if mode == ServeModeManaged {
			runtimeAccessURL = publicURL(state.TailscaleIPv4, state.PublicPort)
		}
		command := serverCommandFor(
			script, root, "127.0.0.1", state.LocalPort, allowedHosts, mode, state.PortlessURL,
			runtimeAccessURL,
			state.APIs,
			state.Data,
		)
		command.Env = mergeEnvironment(command.Env, environmentMap(environment))
		if state.APIs == APIsModeSimulated && state.Data == DataModeLocal {
			command.Env = mergeEnvironment(command.Env, map[string]string{
				"PROJECT_SPACE_SIMULATION_STATE": manager.store.simulationStatePath(state.ServerID),
			})
		}
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
		portlessTarget, err := probeTargetForURL(state.PortlessURL, script.HealthPath())
		if err != nil {
			failure, failErr := manager.failStart(state, err)
			return runtimeState{}, failure, failErr
		}
		if err := manager.prober.Wait(ctx, portlessTarget, script.Timeout()); err != nil {
			failure, failErr := manager.failStart(state, fmt.Errorf("Portless URL did not become ready: %w", err))
			return runtimeState{}, failure, failErr
		}
		return state, ServeResult{}, nil
	}
	panic("unreachable bounded port-race loop")
}
