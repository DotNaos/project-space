package machineconnect

import (
	"errors"
	"io/fs"
	"os"
	"time"
)

type connectorSupervisorDecision struct {
	Action      string `json:"action"`
	OperationID string `json:"operationId"`
	Schema      string `json:"schema"`
}

func (maintenance *ConnectorSupervisorMaintenance) RecoverStartup() (
	ConnectorSupervisorMaintenanceResult,
	error,
) {
	if err := maintenance.ensureDirectories(); err != nil {
		return ConnectorSupervisorMaintenanceResult{}, err
	}
	state, err := maintenance.readState()
	if errors.Is(err, fs.ErrNotExist) {
		if _, controlErr := os.Lstat(maintenance.paths.ControlFile); controlErr == nil {
			return maintenance.ProcessControl()
		} else if !errors.Is(controlErr, fs.ErrNotExist) {
			return ConnectorSupervisorMaintenanceResult{}, stateError("unsafe-control", controlErr)
		}
		return ConnectorSupervisorMaintenanceResult{Outcome: ConnectorSupervisorMaintenanceNone}, nil
	}
	if err != nil {
		return ConnectorSupervisorMaintenanceResult{}, stateError("invalid-state", err)
	}

	switch state.Phase {
	case connectorSupervisorPhaseSwitching:
		current, pointerErr := readManagedPointer(
			maintenance.paths.CurrentPointer,
			maintenance.paths.VersionsRoot,
		)
		if pointerErr != nil {
			return maintenance.recoveryRequired(state, "pointer-unavailable", pointerErr)
		}
		switch current {
		case state.NextPointer:
			state.Phase = connectorSupervisorPhasePendingHealth
			if err := maintenance.writeState(state); err != nil {
				return ConnectorSupervisorMaintenanceResult{}, stateError("persist-recovery", err)
			}
		case state.PreviousPointer:
			state.Phase = connectorSupervisorPhaseRolledBack
			if err := maintenance.writeState(state); err != nil {
				return ConnectorSupervisorMaintenanceResult{}, stateError("persist-rollback", err)
			}
			_ = removeIfExists(maintenance.paths.ControlFile)
			return rolledBackConnectorSupervisorResult(state), nil
		default:
			return maintenance.recoveryRequired(
				state,
				"pointer-mismatch",
				errors.New("managed pointer matches neither side of the interrupted update"),
			)
		}
	case connectorSupervisorPhasePendingHealth:
		current, pointerErr := readManagedPointer(
			maintenance.paths.CurrentPointer,
			maintenance.paths.VersionsRoot,
		)
		if pointerErr != nil {
			return maintenance.recoveryRequired(state, "pointer-unavailable", pointerErr)
		}
		if current == state.PreviousPointer && state.Operation == ConnectorSupervisorMaintenanceUpdate {
			state.Phase = connectorSupervisorPhaseRolledBack
			if err := maintenance.writeState(state); err != nil {
				return ConnectorSupervisorMaintenanceResult{}, stateError("persist-rollback", err)
			}
			return rolledBackConnectorSupervisorResult(state), nil
		}
		if current != state.NextPointer {
			return maintenance.recoveryRequired(
				state,
				"pointer-mismatch",
				errors.New("managed pointer changed during health verification"),
			)
		}
	case connectorSupervisorPhaseRolledBack:
		if state.Operation == ConnectorSupervisorMaintenanceUpdate {
			current, pointerErr := readManagedPointer(
				maintenance.paths.CurrentPointer,
				maintenance.paths.VersionsRoot,
			)
			if pointerErr != nil || current != state.PreviousPointer {
				return maintenance.recoveryRequired(
					state,
					"rollback-pointer-mismatch",
					pointerErr,
				)
			}
		}
		return rolledBackConnectorSupervisorResult(state), nil
	case connectorSupervisorPhaseFailed:
		return ConnectorSupervisorMaintenanceResult{
			Operation:   state.Operation,
			OperationID: state.OperationID,
			Outcome:     ConnectorSupervisorMaintenanceFailed,
		}, nil
	case connectorSupervisorPhaseRecovery:
		return ConnectorSupervisorMaintenanceResult{
			Operation:   state.Operation,
			OperationID: state.OperationID,
			Outcome:     ConnectorSupervisorMaintenanceRecoveryRequired,
		}, maintenanceError(state.FailureCode, errors.New("manual recovery is required"))
	}

	maintenance.discardPersistedControl(state.OperationID)
	deadline, _ := time.Parse(time.RFC3339Nano, state.DeadlineAt)
	if !maintenance.now().Before(deadline) {
		result, healthErr := maintenance.handleHealthFailure(state, "health-timeout")
		if state.Operation == ConnectorSupervisorMaintenanceRestart &&
			result.Outcome == ConnectorSupervisorMaintenanceFailed {
			// The replacement supervisor is already running. Keep the durable
			// failure for Retry, but restore the unchanged connector now instead
			// of requiring a third service-manager start.
			result.RestartRequired = false
		}
		return result, healthErr
	}
	return pendingConnectorSupervisorResult(state), nil
}

func (maintenance *ConnectorSupervisorMaintenance) ProcessControl() (
	ConnectorSupervisorMaintenanceResult,
	error,
) {
	if err := maintenance.ensureDirectories(); err != nil {
		return ConnectorSupervisorMaintenanceResult{}, err
	}
	if state, err := maintenance.readState(); err == nil {
		if state.Phase != connectorSupervisorPhaseRolledBack &&
			state.Phase != connectorSupervisorPhaseFailed {
			return ConnectorSupervisorMaintenanceResult{}, maintenanceError(
				"operation-conflict",
				errors.New("another maintenance operation is active"),
			)
		}
		if err := maintenance.removeState(); err != nil {
			return ConnectorSupervisorMaintenanceResult{}, stateError("clear-finished-state", err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return ConnectorSupervisorMaintenanceResult{}, stateError("invalid-state", err)
	}
	request, err := maintenance.readControl()
	if err != nil {
		maintenance.discardControl(nil)
		return ConnectorSupervisorMaintenanceResult{}, maintenanceError("invalid-control", err)
	}
	defer maintenance.discardControl(&request)
	if request.Target != maintenance.target {
		return ConnectorSupervisorMaintenanceResult{}, maintenanceError(
			"wrong-target",
			errors.New("maintenance target does not match this machine"),
		)
	}
	if request.Operation == ConnectorSupervisorMaintenanceUpdate &&
		maintenance.target == "windows-x64" {
		_ = removeIfExists(maintenance.paths.ControlFile)
		return ConnectorSupervisorMaintenanceResult{}, maintenanceError(
			"unsupported-update",
			errors.New("managed Windows replacement has no safe per-user updater boundary"),
		)
	}
	previousPointer, err := readManagedPointer(
		maintenance.paths.CurrentPointer,
		maintenance.paths.VersionsRoot,
	)
	if err != nil {
		return ConnectorSupervisorMaintenanceResult{}, maintenanceError(
			"unmanaged-installation",
			err,
		)
	}
	nextPointer := previousPointer
	if request.Operation == ConnectorSupervisorMaintenanceUpdate {
		artifact, err := maintenance.verifyAndOpenArtifact(*request.Artifact)
		if err != nil {
			return ConnectorSupervisorMaintenanceResult{}, maintenanceError("artifact-integrity", err)
		}
		nextPointer, err = maintenance.installArchive(request, artifact)
		closeErr := artifact.Close()
		if err != nil || closeErr != nil {
			return ConnectorSupervisorMaintenanceResult{}, maintenanceError(
				"artifact-installation",
				errors.Join(err, closeErr),
			)
		}
	}

	startedAt := maintenance.now().UTC()
	state := connectorSupervisorMaintenanceState{
		DeadlineAt:      startedAt.Add(maintenance.healthTimeout).Format(time.RFC3339Nano),
		ExpectedRuntime: cloneConnectorSupervisorFingerprint(request.ExpectedRuntime),
		NextPointer:     nextPointer,
		Operation:       request.Operation,
		OperationID:     request.OperationID,
		Phase:           connectorSupervisorPhasePendingHealth,
		PreviousPointer: previousPointer,
		PreviousRuntime: cloneConnectorSupervisorFingerprint(request.PreviousRuntime),
		Schema:          ConnectorSupervisorMaintenanceStateSchema,
		StartedAt:       startedAt.Format(time.RFC3339Nano),
		Target:          request.Target,
	}
	if request.Operation == ConnectorSupervisorMaintenanceUpdate {
		state.Phase = connectorSupervisorPhaseSwitching
	}
	if err := maintenance.writeState(state); err != nil {
		return ConnectorSupervisorMaintenanceResult{}, stateError("persist-operation", err)
	}
	if request.Operation == ConnectorSupervisorMaintenanceUpdate {
		if maintenance.beforePointerSwitch != nil {
			if err := maintenance.beforePointerSwitch(); err != nil {
				return ConnectorSupervisorMaintenanceResult{}, err
			}
		}
		if err := switchManagedPointer(
			maintenance.paths.CurrentPointer,
			maintenance.paths.ToolsRoot,
			maintenance.paths.VersionsRoot,
			nextPointer,
		); err != nil {
			return maintenance.recoveryRequired(state, "pointer-switch-failed", err)
		}
		if maintenance.afterPointerSwitch != nil {
			if err := maintenance.afterPointerSwitch(); err != nil {
				return ConnectorSupervisorMaintenanceResult{}, err
			}
		}
		state.Phase = connectorSupervisorPhasePendingHealth
		if err := maintenance.writeState(state); err != nil {
			return ConnectorSupervisorMaintenanceResult{}, stateError("persist-health-state", err)
		}
	}
	_ = removeIfExists(maintenance.paths.DecisionFile)
	_ = syncConnectorSupervisorDirectory(maintenance.paths.MaintenanceRoot)
	return ConnectorSupervisorMaintenanceResult{
		Evidence: &ConnectorSupervisorMaintenanceEvidence{
			OperationID: state.OperationID,
			State:       ConnectorSupervisorEvidencePending,
		},
		Operation:       state.Operation,
		OperationID:     state.OperationID,
		Outcome:         ConnectorSupervisorMaintenanceRestartRequested,
		RestartRequired: true,
	}, nil
}

func (maintenance *ConnectorSupervisorMaintenance) CheckHealthDecision() (
	ConnectorSupervisorMaintenanceResult,
	bool,
	error,
) {
	if err := maintenance.ensureDirectories(); err != nil {
		return ConnectorSupervisorMaintenanceResult{}, false, err
	}
	state, err := maintenance.readState()
	if errors.Is(err, fs.ErrNotExist) {
		return ConnectorSupervisorMaintenanceResult{Outcome: ConnectorSupervisorMaintenanceNone}, false, nil
	}
	if err != nil {
		return ConnectorSupervisorMaintenanceResult{}, false, stateError("invalid-state", err)
	}
	if state.Phase == connectorSupervisorPhaseRolledBack {
		return maintenance.checkRolledBackAcknowledgement(state)
	}
	if state.Phase != connectorSupervisorPhasePendingHealth {
		return stateResult(state), true, nil
	}
	body, err := readConnectorSupervisorPrivateFile(
		maintenance.paths.DecisionFile,
		maximumConnectorSupervisorDecisionBytes,
	)
	if errors.Is(err, fs.ErrNotExist) {
		deadline, _ := time.Parse(time.RFC3339Nano, state.DeadlineAt)
		if maintenance.now().Before(deadline) {
			return pendingConnectorSupervisorResult(state), false, nil
		}
		result, timeoutErr := maintenance.handleHealthFailure(state, "health-timeout")
		return result, true, timeoutErr
	}
	if err != nil {
		return ConnectorSupervisorMaintenanceResult{}, false, maintenanceError("invalid-decision", err)
	}
	var decision connectorSupervisorDecision
	if err := decodeConnectorSupervisorJSON(body, &decision); err != nil ||
		decision.Schema != ConnectorSupervisorDecisionSchema ||
		!validConnectorSupervisorIdentifier(decision.OperationID, 256) ||
		(decision.Action != "commit" && decision.Action != "rollback") {
		_ = removeIfExists(maintenance.paths.DecisionFile)
		if err == nil {
			err = errors.New("health decision has an invalid shape")
		}
		return pendingConnectorSupervisorResult(state), false, maintenanceError(
			"invalid-decision",
			err,
		)
	}
	if decision.OperationID != state.OperationID {
		_ = removeIfExists(maintenance.paths.DecisionFile)
		return pendingConnectorSupervisorResult(state), false, maintenanceError(
			"stale-decision",
			errors.New("health decision does not match the pending operation"),
		)
	}
	if err := removeIfExists(maintenance.paths.DecisionFile); err != nil {
		return ConnectorSupervisorMaintenanceResult{}, false, maintenanceError("decision-cleanup", err)
	}
	if decision.Action == "rollback" {
		result, rollbackErr := maintenance.handleHealthFailure(state, "health-rejected")
		return result, true, rollbackErr
	}
	current, err := readManagedPointer(
		maintenance.paths.CurrentPointer,
		maintenance.paths.VersionsRoot,
	)
	if err != nil || current != state.NextPointer {
		result, recoveryErr := maintenance.recoveryRequired(
			state,
			"commit-pointer-mismatch",
			err,
		)
		return result, true, recoveryErr
	}
	if err := maintenance.removeState(); err != nil {
		return ConnectorSupervisorMaintenanceResult{}, true, stateError("commit-cleanup", err)
	}
	return ConnectorSupervisorMaintenanceResult{
		Operation:   state.Operation,
		OperationID: state.OperationID,
		Outcome:     ConnectorSupervisorMaintenanceSucceeded,
	}, true, nil
}

func (maintenance *ConnectorSupervisorMaintenance) HandleHealthTimeout() (
	ConnectorSupervisorMaintenanceResult,
	error,
) {
	state, err := maintenance.readState()
	if err != nil {
		return ConnectorSupervisorMaintenanceResult{}, stateError("invalid-state", err)
	}
	if state.Phase != connectorSupervisorPhasePendingHealth {
		return stateResult(state), nil
	}
	deadline, _ := time.Parse(time.RFC3339Nano, state.DeadlineAt)
	if maintenance.now().Before(deadline) {
		return pendingConnectorSupervisorResult(state), nil
	}
	return maintenance.handleHealthFailure(state, "health-timeout")
}

func (maintenance *ConnectorSupervisorMaintenance) AcknowledgeOutcome(operationID string) error {
	state, err := maintenance.readState()
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return stateError("invalid-state", err)
	}
	if state.OperationID != operationID ||
		(state.Phase != connectorSupervisorPhaseRolledBack &&
			state.Phase != connectorSupervisorPhaseFailed) {
		return maintenanceError("outcome-mismatch", errors.New("maintenance outcome does not match"))
	}
	return maintenance.removeState()
}

func (maintenance *ConnectorSupervisorMaintenance) handleHealthFailure(
	state connectorSupervisorMaintenanceState,
	code string,
) (ConnectorSupervisorMaintenanceResult, error) {
	_ = removeIfExists(maintenance.paths.DecisionFile)
	if state.Operation == ConnectorSupervisorMaintenanceRestart {
		state.Phase = connectorSupervisorPhaseFailed
		state.FailureCode = code
		if err := maintenance.writeState(state); err != nil {
			return ConnectorSupervisorMaintenanceResult{}, stateError("persist-failure", err)
		}
		return ConnectorSupervisorMaintenanceResult{
			Operation:       state.Operation,
			OperationID:     state.OperationID,
			Outcome:         ConnectorSupervisorMaintenanceFailed,
			RestartRequired: true,
		}, nil
	}
	current, err := readManagedPointer(
		maintenance.paths.CurrentPointer,
		maintenance.paths.VersionsRoot,
	)
	if err != nil {
		return maintenance.recoveryRequired(state, "rollback-pointer-unavailable", err)
	}
	if current != state.PreviousPointer {
		if current != state.NextPointer {
			return maintenance.recoveryRequired(
				state,
				"rollback-pointer-mismatch",
				errors.New("managed pointer changed before rollback"),
			)
		}
		if err := switchManagedPointer(
			maintenance.paths.CurrentPointer,
			maintenance.paths.ToolsRoot,
			maintenance.paths.VersionsRoot,
			state.PreviousPointer,
		); err != nil {
			return maintenance.recoveryRequired(state, "rollback-failed", err)
		}
	}
	state.Phase = connectorSupervisorPhaseRolledBack
	state.FailureCode = ""
	if err := maintenance.writeState(state); err != nil {
		return ConnectorSupervisorMaintenanceResult{}, stateError("persist-rollback", err)
	}
	result := rolledBackConnectorSupervisorResult(state)
	result.RestartRequired = true
	return result, nil
}

func (maintenance *ConnectorSupervisorMaintenance) recoveryRequired(
	state connectorSupervisorMaintenanceState,
	code string,
	cause error,
) (ConnectorSupervisorMaintenanceResult, error) {
	if cause == nil {
		cause = errors.New("managed maintenance state is inconsistent")
	}
	state.Phase = connectorSupervisorPhaseRecovery
	state.FailureCode = code
	if err := maintenance.writeState(state); err != nil {
		cause = errors.Join(cause, err)
	}
	return ConnectorSupervisorMaintenanceResult{
		Operation:   state.Operation,
		OperationID: state.OperationID,
		Outcome:     ConnectorSupervisorMaintenanceRecoveryRequired,
	}, maintenanceError(code, cause)
}
