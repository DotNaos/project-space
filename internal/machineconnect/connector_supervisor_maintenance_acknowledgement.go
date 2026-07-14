package machineconnect

import (
	"errors"
	"io/fs"
)

func (maintenance *ConnectorSupervisorMaintenance) checkRolledBackAcknowledgement(
	state connectorSupervisorMaintenanceState,
) (ConnectorSupervisorMaintenanceResult, bool, error) {
	result := rolledBackConnectorSupervisorResult(state)
	body, err := readConnectorSupervisorPrivateFile(
		maintenance.paths.DecisionFile,
		maximumConnectorSupervisorDecisionBytes,
	)
	if errors.Is(err, fs.ErrNotExist) {
		return result, false, nil
	}
	if err != nil {
		return result, false, maintenanceError("invalid-decision", err)
	}
	var decision connectorSupervisorDecision
	if err := decodeConnectorSupervisorJSON(body, &decision); err != nil ||
		decision.Schema != ConnectorSupervisorDecisionSchema ||
		!validConnectorSupervisorIdentifier(decision.OperationID, 256) ||
		(decision.Action != "commit" && decision.Action != "rollback") {
		_ = removeIfExists(maintenance.paths.DecisionFile)
		if err == nil {
			err = errors.New("rollback acknowledgement has an invalid shape")
		}
		return result, false, maintenanceError("invalid-decision", err)
	}
	if decision.OperationID != state.OperationID {
		_ = removeIfExists(maintenance.paths.DecisionFile)
		return result, false, maintenanceError(
			"stale-decision",
			errors.New("rollback acknowledgement does not match the completed operation"),
		)
	}
	if decision.Action != "rollback" {
		_ = removeIfExists(maintenance.paths.DecisionFile)
		return result, false, maintenanceError(
			"invalid-decision",
			errors.New("rolled-back reconnect requires a rollback acknowledgement"),
		)
	}
	if err := removeIfExists(maintenance.paths.DecisionFile); err != nil {
		return result, false, maintenanceError("decision-cleanup", err)
	}
	if err := maintenance.AcknowledgeOutcome(state.OperationID); err != nil {
		return result, false, err
	}
	return result, true, nil
}
