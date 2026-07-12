package projectrun

import (
	"context"
	"fmt"
)

func (manager *Manager) Run(
	ctx context.Context,
	directory string,
	scriptName string,
	streams Streams,
) (RunResult, error) {
	root, script, err := LoadScript(directory, scriptName)
	if err != nil {
		return manager.runErrorResult(root, scriptName, nil, 0, err), err
	}
	reserved, err := manager.reservedLocalPorts()
	if err != nil {
		return manager.runErrorResult(root, scriptName, script.Command, 0, err), err
	}
	port, err := manager.ports.Local(reserved)
	if err != nil {
		return manager.runErrorResult(root, scriptName, script.Command, 0, err), err
	}
	command := commandFor(script, root, "127.0.0.1", port, nil)
	command.InheritEnv = true
	startedAt := manager.timestamp()
	exitCode, runErr := manager.processes.RunForeground(ctx, command, streams, nil)
	finishedAt := manager.timestamp()
	result := RunResult{
		SchemaVersion: SchemaVersion,
		Operation:     "run",
		Script:        scriptName,
		Directory:     root,
		State:         "exited",
		Command:       append([]string{}, command.Argv...),
		LocalPort:     port,
		LocalURL:      localURL(port),
		StartedAt:     startedAt,
		FinishedAt:    finishedAt,
		ExitCode:      pointer(exitCode),
	}
	if runErr != nil {
		result.State = "error"
		result.LastError = pointer(runErr.Error())
	}
	return result, runErr
}

func (manager *Manager) reservedLocalPorts() (map[int]bool, error) {
	unlock, err := acquireFileLock(manager.store.portLockPath())
	if err != nil {
		return nil, err
	}
	defer unlock()
	listing, err := manager.store.list()
	if err != nil {
		return nil, err
	}
	reserved := map[int]bool{}
	for _, state := range listing.States {
		if state.LocalPort > 0 {
			reserved[state.LocalPort] = true
		}
	}
	return reserved, nil
}

func (manager *Manager) runErrorResult(
	directory string,
	script string,
	command []string,
	port int,
	cause error,
) RunResult {
	timestamp := manager.timestamp()
	result := RunResult{
		SchemaVersion: SchemaVersion,
		Operation:     "run",
		Script:        script,
		Directory:     directory,
		State:         "error",
		Command:       append([]string{}, command...),
		LocalPort:     port,
		StartedAt:     timestamp,
		FinishedAt:    timestamp,
		LastError:     pointer(cause.Error()),
	}
	if port > 0 {
		result.LocalURL = localURL(port)
	}
	return result
}

func ValidateScriptName(name string) error {
	if !declarationPattern.MatchString(name) {
		return fmt.Errorf("script name %q is invalid", name)
	}
	return nil
}
