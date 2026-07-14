package machineconnect

import (
	"fmt"
	"path/filepath"
)

func pendingConnectorSupervisorResult(
	state connectorSupervisorMaintenanceState,
) ConnectorSupervisorMaintenanceResult {
	return ConnectorSupervisorMaintenanceResult{
		Evidence: &ConnectorSupervisorMaintenanceEvidence{
			OperationID: state.OperationID,
			State:       ConnectorSupervisorEvidencePending,
		},
		Operation:   state.Operation,
		OperationID: state.OperationID,
		Outcome:     ConnectorSupervisorMaintenancePendingHealth,
	}
}

func rolledBackConnectorSupervisorResult(
	state connectorSupervisorMaintenanceState,
) ConnectorSupervisorMaintenanceResult {
	return ConnectorSupervisorMaintenanceResult{
		Evidence: &ConnectorSupervisorMaintenanceEvidence{
			OperationID: state.OperationID,
			State:       ConnectorSupervisorEvidenceRolledBack,
		},
		Operation:   state.Operation,
		OperationID: state.OperationID,
		Outcome:     ConnectorSupervisorMaintenanceRolledBack,
	}
}

func stateResult(state connectorSupervisorMaintenanceState) ConnectorSupervisorMaintenanceResult {
	switch state.Phase {
	case connectorSupervisorPhasePendingHealth, connectorSupervisorPhaseSwitching:
		return pendingConnectorSupervisorResult(state)
	case connectorSupervisorPhaseRolledBack:
		return rolledBackConnectorSupervisorResult(state)
	case connectorSupervisorPhaseFailed:
		return ConnectorSupervisorMaintenanceResult{
			Operation: state.Operation, OperationID: state.OperationID,
			Outcome: ConnectorSupervisorMaintenanceFailed,
		}
	default:
		return ConnectorSupervisorMaintenanceResult{
			Operation: state.Operation, OperationID: state.OperationID,
			Outcome: ConnectorSupervisorMaintenanceRecoveryRequired,
		}
	}
}

func (result ConnectorSupervisorMaintenanceResult) String() string {
	return fmt.Sprintf("%s:%s:%s", result.Operation, result.OperationID, result.Outcome)
}

func (maintenance *ConnectorSupervisorMaintenance) discardPersistedControl(operationID string) {
	request, err := maintenance.readControl()
	if err == nil && request.OperationID == operationID {
		maintenance.discardControl(&request)
		return
	}
	maintenance.discardControl(nil)
}

func (maintenance *ConnectorSupervisorMaintenance) discardControl(
	request *connectorSupervisorControlRequest,
) {
	if request != nil && request.Artifact != nil &&
		request.Artifact.Path != "" &&
		request.Artifact.Path == filepath.Clean(request.Artifact.Path) &&
		filepath.Dir(request.Artifact.Path) == maintenance.paths.StagingRoot {
		_ = removeIfExists(request.Artifact.Path)
	}
	_ = removeIfExists(maintenance.paths.ControlFile)
	_ = syncConnectorSupervisorDirectory(maintenance.paths.MaintenanceRoot)
}
