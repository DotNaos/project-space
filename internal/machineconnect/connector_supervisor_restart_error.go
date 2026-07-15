package machineconnect

import "errors"

type connectorSupervisorRestartError struct {
	cause error
}

func (restart *connectorSupervisorRestartError) Error() string {
	return errors.Join(ErrConnectorSupervisorRestartRequired, restart.cause).Error()
}

func (restart *connectorSupervisorRestartError) Unwrap() []error {
	if restart.cause == nil {
		return []error{ErrConnectorSupervisorRestartRequired}
	}
	return []error{ErrConnectorSupervisorRestartRequired, restart.cause}
}

func connectorSupervisorRestart(cause error) error {
	return &connectorSupervisorRestartError{cause: cause}
}

// CanRelaunchConnectorSupervisor accepts only a direct restart disposition.
// Wrapping it with any cleanup or lifecycle failure deliberately makes the
// result ineligible for an automatic process handoff.
func CanRelaunchConnectorSupervisor(err error) bool {
	if err == ErrConnectorSupervisorRestartRequired {
		return true
	}
	_, ok := err.(*connectorSupervisorRestartError)
	return ok
}
