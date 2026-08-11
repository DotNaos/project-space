package machineconnect

import (
	"errors"
	"io/fs"
)

type connectorSupervisorOutcome struct {
	Action      string `json:"action"`
	OperationID string `json:"operationId"`
	Schema      string `json:"schema"`
}

func validConnectorSupervisorCommitOutcome(
	outcome connectorSupervisorOutcome,
) bool {
	return outcome.Schema == ConnectorSupervisorOutcomeSchema &&
		outcome.Action == "commit" &&
		validConnectorSupervisorIdentifier(outcome.OperationID, 256)
}

func (maintenance *ConnectorSupervisorMaintenance) readCommitOutcome() (
	connectorSupervisorOutcome,
	error,
) {
	body, err := readConnectorSupervisorPrivateFile(
		maintenance.paths.OutcomeFile,
		maximumConnectorSupervisorOutcomeBytes,
	)
	if err != nil {
		return connectorSupervisorOutcome{}, err
	}
	var outcome connectorSupervisorOutcome
	if err := decodeConnectorSupervisorJSON(body, &outcome); err != nil ||
		!validConnectorSupervisorCommitOutcome(outcome) {
		if err == nil {
			err = errors.New("supervisor outcome has an invalid shape")
		}
		return connectorSupervisorOutcome{}, err
	}
	return outcome, nil
}

func (maintenance *ConnectorSupervisorMaintenance) writeCommitOutcome(
	operationID string,
) error {
	existing, err := maintenance.readCommitOutcome()
	if err == nil {
		if existing.OperationID != operationID {
			return maintenanceError(
				"outcome-conflict",
				errors.New("another supervisor commit outcome is awaiting acknowledgement"),
			)
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return maintenanceError("invalid-outcome", err)
	}
	return writeConnectorSupervisorPrivateJSON(
		maintenance.paths.OutcomeFile,
		connectorSupervisorOutcome{
			Action:      "commit",
			OperationID: operationID,
			Schema:      ConnectorSupervisorOutcomeSchema,
		},
	)
}

func (maintenance *ConnectorSupervisorMaintenance) removeCommitOutcome() error {
	if err := removeIfExists(maintenance.paths.OutcomeFile); err != nil {
		return err
	}
	return syncConnectorSupervisorDirectory(maintenance.paths.MaintenanceRoot)
}

func (maintenance *ConnectorSupervisorMaintenance) recoverAcceptedCommit(
	state connectorSupervisorMaintenanceState,
) (ConnectorSupervisorMaintenanceResult, bool, error) {
	outcome, err := maintenance.readCommitOutcome()
	if errors.Is(err, fs.ErrNotExist) {
		return ConnectorSupervisorMaintenanceResult{}, false, nil
	}
	if err != nil {
		return ConnectorSupervisorMaintenanceResult{}, false,
			maintenanceError("invalid-outcome", err)
	}
	if outcome.OperationID != state.OperationID {
		return ConnectorSupervisorMaintenanceResult{}, false, maintenanceError(
			"outcome-mismatch",
			errors.New("supervisor commit outcome does not match pending maintenance"),
		)
	}
	result, err := maintenance.finalizeAcceptedCommit(state)
	return result, true, err
}

func (maintenance *ConnectorSupervisorMaintenance) finalizeAcceptedCommit(
	state connectorSupervisorMaintenanceState,
) (ConnectorSupervisorMaintenanceResult, error) {
	current, err := readManagedPointer(
		maintenance.paths.CurrentPointer,
		maintenance.paths.VersionsRoot,
	)
	if err != nil || current != state.NextPointer {
		return maintenance.recoveryRequired(
			state,
			"commit-pointer-mismatch",
			err,
		)
	}
	if err := removeIfExists(maintenance.paths.DecisionFile); err != nil {
		return ConnectorSupervisorMaintenanceResult{},
			maintenanceError("decision-cleanup", err)
	}
	if err := syncConnectorSupervisorDirectory(maintenance.paths.MaintenanceRoot); err != nil {
		return ConnectorSupervisorMaintenanceResult{},
			maintenanceError("decision-cleanup", err)
	}
	if err := maintenance.removeState(); err != nil {
		return ConnectorSupervisorMaintenanceResult{}, stateError("commit-cleanup", err)
	}
	return ConnectorSupervisorMaintenanceResult{
		Operation:   state.Operation,
		OperationID: state.OperationID,
		Outcome:     ConnectorSupervisorMaintenanceSucceeded,
	}, nil
}
