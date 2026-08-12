package projectrun

import "errors"

func (manager *Manager) resultFromState(
	operation string,
	capability Capability,
	state runtimeState,
	err error,
) ServeResult {
	result := ServeResult{
		SchemaVersion:     SchemaVersion,
		Operation:         operation,
		Mode:              state.Mode,
		APIs:              state.APIs,
		Data:              state.Data,
		ServerID:          state.ServerID,
		ServerGeneration:  state.Generation,
		ServerKey:         state.Script,
		Script:            state.Script,
		Directory:         state.Directory,
		Repository:        state.RepositoryPath,
		TmuxSession:       state.TmuxSession,
		WorkspaceID:       state.WorkspaceID,
		RuntimeGeneration: state.RuntimeGeneration,
		PortlessName:      state.PortlessName,
		Capability:        capability,
		State:             state.State,
		AllowedHosts:      append([]string{}, state.AllowedHosts...),
		CheckedAt:         state.CheckedAt,
	}
	if result.APIs == "" {
		result.APIs = APIsModeSimulated
	}
	if result.Data == "" {
		result.Data = DataModeLocal
	}
	if result.APIs == APIsModeSimulated {
		result.Secrets = "none"
	} else {
		result.Secrets = "required"
	}
	if result.Mode == "" {
		result.Mode = ServeModeManaged
	}
	if result.AllowedHosts == nil {
		result.AllowedHosts = []string{}
	}
	if result.CheckedAt == "" {
		result.CheckedAt = manager.timestamp()
	}
	if state.PID > 0 {
		result.PID = pointer(state.PID)
	}
	if state.LocalPort > 0 {
		result.LocalPort = pointer(state.LocalPort)
	}
	if state.PortlessURL != "" {
		result.LocalURL = pointer(state.PortlessURL)
	}
	if state.Mode == ServeModeManaged && state.PublicPort > 0 {
		result.PublicPort = pointer(state.PublicPort)
	}
	if state.Mode == ServeModeManaged && state.TailscaleIPv4 != "" {
		result.TailscaleIPv4 = pointer(state.TailscaleIPv4)
		if state.PublicPort > 0 {
			result.PublicURL = pointer(publicURL(state.TailscaleIPv4, state.PublicPort))
		}
	}
	if state.StartedAt != "" {
		result.StartedAt = pointer(state.StartedAt)
	}
	if err != nil {
		result.LastError = pointer(err.Error())
	} else if state.LastError != "" {
		result.LastError = pointer(state.LastError)
	}
	return result
}

func (manager *Manager) stoppedResult(
	operation string,
	directory string,
	script string,
	capability Capability,
) ServeResult {
	return manager.resultFromState(operation, capability, runtimeState{
		Directory:    directory,
		Script:       script,
		State:        StateStopped,
		AllowedHosts: []string{},
		CheckedAt:    manager.timestamp(),
	}, nil)
}

func (manager *Manager) unavailableResult(
	operation string,
	directory string,
	script string,
	cause error,
) ServeResult {
	result := manager.stoppedResult(operation, directory, script, CapabilityUnavailable)
	if cause != nil {
		result.LastError = pointer(cause.Error())
	}
	return result
}

func (manager *Manager) configErrorResult(
	operation string,
	directory string,
	script string,
	cause error,
) ServeResult {
	if errors.Is(cause, ErrNotConfigured) || errors.Is(cause, ErrScriptNotFound) {
		result := manager.unavailableResult(operation, directory, script, cause)
		result.State = StateError
		return result
	}
	return manager.resultFromState(operation, CapabilityUnavailable, runtimeState{
		Directory:    directory,
		Script:       script,
		State:        StateError,
		AllowedHosts: []string{},
		CheckedAt:    manager.timestamp(),
	}, cause)
}

func (manager *Manager) runtimeErrorResult(
	operation string,
	directory string,
	script string,
	cause error,
) ServeResult {
	return manager.resultFromState(operation, CapabilityConfigured, runtimeState{
		Directory:    directory,
		Script:       script,
		State:        StateError,
		AllowedHosts: []string{},
		CheckedAt:    manager.timestamp(),
	}, cause)
}

func pointer[T any](value T) *T {
	return &value
}

func localURL(port int) string {
	return "http://127.0.0.1:" + integer(port)
}

func publicURL(address string, port int) string {
	return "http://" + address + ":" + integer(port)
}

func integer(value int) string {
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	buffer := [20]byte{}
	position := len(buffer)
	for value > 0 {
		position--
		buffer[position] = digits[value%10]
		value /= 10
	}
	return string(buffer[position:])
}
