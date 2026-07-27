package machineconnect

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

var ErrConnectorSupervisorRestartRequired = errors.New("connector supervisor restart required")

type connectorSupervisorHealthResult struct {
	result ConnectorSupervisorMaintenanceResult
	err    error
}

func (supervisor *ConnectorSupervisor) resolveMaintenance(
	machineID string,
) (*ConnectorSupervisorMaintenance, error) {
	if supervisor.maintenance != nil {
		if supervisor.maintenance.expectedMachineID != machineID {
			return nil, errors.New("connector supervisor maintenance machine identity does not match")
		}
		return supervisor.maintenance, nil
	}
	if _, managed := possibleConnectorSupervisorToolsRoot(supervisor.executable); !managed {
		return nil, nil
	}
	toolsRoot, err := ResolveConnectorSupervisorMaintenanceToolsRoot(supervisor.executable)
	if err != nil {
		return nil, fmt.Errorf("initialize connector supervisor maintenance: %w", err)
	}
	resolvedExecutable, err := filepath.EvalSymlinks(filepath.Clean(supervisor.executable))
	if err != nil {
		return nil, fmt.Errorf("initialize connector supervisor maintenance: %w", err)
	}
	releaseDirectory := filepath.Dir(resolvedExecutable)
	target, err := CurrentConnectorSupervisorMaintenanceTarget()
	if err != nil {
		return nil, err
	}
	return NewConnectorSupervisorMaintenance(ConnectorSupervisorMaintenanceOptions{
		CommandVerificationKeyFile: filepath.Join(
			releaseDirectory,
			connectorSupervisorCommandKeyFileName,
		),
		ExpectedMachineID: machineID,
		ReleaseVerificationKeyFile: filepath.Join(
			releaseDirectory,
			connectorSupervisorReleaseKeyFileName,
		),
		Target:    target,
		ToolsRoot: toolsRoot,
	})
}

func possibleConnectorSupervisorToolsRoot(executable string) (string, bool) {
	if !filepath.IsAbs(executable) || strings.ContainsRune(executable, '\x00') {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(executable))
	if err != nil {
		return "", false
	}
	versionDirectory := filepath.Dir(resolved)
	versionsRoot := filepath.Dir(versionDirectory)
	toolsRoot := filepath.Dir(versionsRoot)
	if filepath.Base(versionsRoot) != connectorSupervisorVersionsDirectoryName ||
		filepath.Base(toolsRoot) != ".project-space-machine-tools" ||
		!managedPointerComponentPattern.MatchString(filepath.Base(versionDirectory)) {
		return "", false
	}
	return toolsRoot, true
}

func (maintenance *ConnectorSupervisorMaintenance) ManagedConnectorExecutable() (string, error) {
	pointer, err := readManagedPointer(
		maintenance.paths.CurrentPointer,
		maintenance.paths.VersionsRoot,
	)
	if err != nil {
		return "", maintenanceError("managed-connector-unavailable", err)
	}
	name := "project-space-connector"
	if maintenance.target == "windows-x64" {
		name += ".exe"
	}
	path := filepath.Join(
		maintenance.paths.VersionsRoot,
		filepath.Base(pointer),
		name,
	)
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() ||
		(maintenance.target != "windows-x64" &&
			(info.Mode().Perm()&0o111 == 0 || info.Mode().Perm()&0o022 != 0)) {
		return "", maintenanceError(
			"managed-connector-unavailable",
			errors.New("managed connector is not an executable regular file"),
		)
	}
	return path, nil
}

func (maintenance *ConnectorSupervisorMaintenance) HandleConnectorExit() (
	ConnectorSupervisorMaintenanceResult,
	error,
) {
	return maintenance.failPendingHealth("connector-exited")
}

func (maintenance *ConnectorSupervisorMaintenance) failPendingHealth(
	code string,
) (ConnectorSupervisorMaintenanceResult, error) {
	state, err := maintenance.readState()
	if errors.Is(err, fs.ErrNotExist) {
		return ConnectorSupervisorMaintenanceResult{
			Outcome: ConnectorSupervisorMaintenanceNone,
		}, nil
	}
	if err != nil {
		return ConnectorSupervisorMaintenanceResult{}, stateError("invalid-state", err)
	}
	if state.Phase != connectorSupervisorPhasePendingHealth {
		return stateResult(state), nil
	}
	return maintenance.handleHealthFailure(state, code)
}

func (supervisor *ConnectorSupervisor) runConnectorCompanion(
	ctx context.Context,
	lifetime connectorSupervisorLifetime,
	payload []byte,
	maintenance *ConnectorSupervisorMaintenance,
) error {
	executable := supervisor.executable
	environment := connectorEnvironment(supervisor.environ())
	fixedEnvironment := connectorSupervisorBuildEnvironment(supervisor.build)
	fixedEnvironment = append(
		fixedEnvironment,
		CodexOperationSnapshotFileEnv+"="+supervisor.codexOperationSnapshotPath,
	)
	if supervisor.readinessAttemptNonce != "" {
		readinessPath, err := DefaultConnectorRuntimeReadinessPath()
		if err != nil {
			return fmt.Errorf("resolve connector readiness proof: %w", err)
		}
		fixedEnvironment = append(
			fixedEnvironment,
			ConnectorRuntimeReadyFileEnv+"="+readinessPath,
			ConnectorRuntimeReadyAttemptNonceEnv+"="+supervisor.readinessAttemptNonce,
		)
	}
	environment = mergeConnectorEnvironment(environment, fixedEnvironment)
	recovery := ConnectorSupervisorMaintenanceResult{
		Outcome: ConnectorSupervisorMaintenanceNone,
	}
	if maintenance != nil {
		var err error
		recovery, err = maintenance.RecoverStartup()
		if err != nil {
			return fmt.Errorf("recover connector supervisor maintenance: %w", err)
		}
		if recovery.RestartRequired {
			return connectorSupervisorRestart(nil)
		}
		executable, err = maintenance.ManagedConnectorExecutable()
		if err != nil {
			return connectorSupervisorReconnectFailure(maintenance, recovery, "connector-unavailable", err)
		}
		maintenanceEnvironment, err := maintenance.CompanionEnvironment(recovery.Evidence)
		if err != nil {
			return err
		}
		environment = mergeConnectorEnvironment(environment, maintenanceEnvironment)
	}

	commandCtx, cancelCommand := context.WithCancel(ctx)
	defer cancelCommand()
	command := exec.CommandContext(commandCtx, executable, supervisor.arguments...)
	command.Env = environment
	command.Stdout = supervisor.stdout
	command.Stderr = supervisor.stderr
	stdin, err := command.StdinPipe()
	if err != nil {
		return connectorSupervisorReconnectFailure(
			maintenance,
			recovery,
			"connector-input-failed",
			errors.New("open connector companion input"),
		)
	}
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return connectorSupervisorReconnectFailure(
			maintenance,
			recovery,
			"connector-start-failed",
			fmt.Errorf("start connector companion: %w", err),
		)
	}
	if err := lifetime.Attach(command.Process); err != nil {
		_ = stdin.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
		return connectorSupervisorReconnectFailure(
			maintenance,
			recovery,
			"connector-isolation-failed",
			err,
		)
	}

	writeDone := make(chan error, 1)
	go func() {
		written, writeErr := stdin.Write(payload)
		if writeErr == nil && written != len(payload) {
			writeErr = io.ErrShortWrite
		}
		writeDone <- errors.Join(writeErr, stdin.Close())
	}()
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()

	var healthDone <-chan connectorSupervisorHealthResult
	pendingHealth := maintenance != nil &&
		recovery.Outcome == ConnectorSupervisorMaintenancePendingHealth
	waitingForDecision := pendingHealth || maintenance != nil &&
		recovery.Outcome == ConnectorSupervisorMaintenanceRolledBack
	if waitingForDecision {
		results := make(chan connectorSupervisorHealthResult, 1)
		healthDone = results
		go func() {
			result, waitErr := maintenance.WaitForHealthDecision(commandCtx)
			results <- connectorSupervisorHealthResult{result: result, err: waitErr}
		}()
	}

	for {
		select {
		case waitErr := <-waitDone:
			cancelCommand()
			writeErr := <-writeDone
			if ctx.Err() != nil {
				return ctx.Err()
			}
			runErr := connectorSupervisorChildError(waitErr, writeErr)
			if maintenance == nil {
				return runErr
			}
			if pendingHealth {
				result, maintenanceErr := maintenance.HandleConnectorExit()
				if result.RestartRequired {
					return connectorSupervisorRestart(maintenanceErr)
				}
				if maintenanceErr != nil {
					return errors.Join(runErr, maintenanceErr)
				}
			}
			result, maintenanceErr := maintenance.processControlIfPresent()
			if result.RestartRequired {
				return connectorSupervisorRestart(maintenanceErr)
			}
			return errors.Join(runErr, maintenanceErr)

		case health := <-healthDone:
			if health.err == nil && !health.result.RestartRequired &&
				(health.result.Outcome == ConnectorSupervisorMaintenanceSucceeded ||
					health.result.Outcome == ConnectorSupervisorMaintenanceRolledBack) {
				healthDone = nil
				pendingHealth = false
				continue
			}
			cancelCommand()
			_ = command.Process.Kill()
			waitErr := <-waitDone
			writeErr := <-writeDone
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if health.result.RestartRequired {
				return connectorSupervisorRestart(health.err)
			}
			return errors.Join(
				connectorSupervisorChildError(waitErr, writeErr),
				health.err,
			)
		}
	}
}

func connectorSupervisorReconnectFailure(
	maintenance *ConnectorSupervisorMaintenance,
	recovery ConnectorSupervisorMaintenanceResult,
	code string,
	cause error,
) error {
	if maintenance == nil ||
		recovery.Outcome != ConnectorSupervisorMaintenancePendingHealth {
		return cause
	}
	result, maintenanceErr := maintenance.failPendingHealth(code)
	if result.RestartRequired {
		return connectorSupervisorRestart(errors.Join(cause, maintenanceErr))
	}
	return errors.Join(cause, maintenanceErr)
}

func (maintenance *ConnectorSupervisorMaintenance) processControlIfPresent() (
	ConnectorSupervisorMaintenanceResult,
	error,
) {
	if _, err := os.Lstat(maintenance.paths.ControlFile); errors.Is(err, fs.ErrNotExist) {
		return ConnectorSupervisorMaintenanceResult{
			Outcome: ConnectorSupervisorMaintenanceNone,
		}, nil
	} else if err != nil {
		return ConnectorSupervisorMaintenanceResult{}, maintenanceError("inspect-control", err)
	}
	return maintenance.ProcessControl()
}

func connectorSupervisorChildError(waitErr, writeErr error) error {
	var runErr error
	if writeErr != nil {
		runErr = errors.Join(runErr, fmt.Errorf("send connector runtime credential: %w", writeErr))
	}
	if waitErr != nil {
		runErr = errors.Join(runErr, fmt.Errorf("connector companion exited: %w", waitErr))
	}
	return runErr
}

func mergeConnectorEnvironment(base, fixed []string) []string {
	merged := append([]string(nil), base...)
	for _, replacement := range fixed {
		name, _, found := strings.Cut(replacement, "=")
		if !found || name == "" {
			continue
		}
		filtered := merged[:0]
		for _, existing := range merged {
			existingName, _, _ := strings.Cut(existing, "=")
			equal := existingName == name
			if runtime.GOOS == "windows" {
				equal = strings.EqualFold(existingName, name)
			}
			if !equal {
				filtered = append(filtered, existing)
			}
		}
		merged = append(filtered, replacement)
	}
	return merged
}
