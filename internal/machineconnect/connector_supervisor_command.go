package machineconnect

import (
	"errors"
	"strings"
)

const (
	maximumConnectorSupervisorArgumentCount = 32
	maximumConnectorSupervisorArgumentBytes = 16 * 1024
)

// NewConnectorSupervisorCommand runs a fixed companion command while keeping
// the machine credential on the supervisor's stdin-only credential channel.
func NewConnectorSupervisorCommand(
	store CredentialStore,
	options ConnectorSupervisorOptions,
	arguments []string,
) (*ConnectorSupervisor, error) {
	if len(arguments) == 0 || len(arguments) > maximumConnectorSupervisorArgumentCount {
		return nil, errors.New("connector supervisor arguments are invalid")
	}
	totalBytes := 0
	validated := make([]string, len(arguments))
	for index, argument := range arguments {
		if argument == "" || strings.ContainsRune(argument, '\x00') {
			return nil, errors.New("connector supervisor argument is invalid")
		}
		totalBytes += len(argument)
		if totalBytes > maximumConnectorSupervisorArgumentBytes {
			return nil, errors.New("connector supervisor arguments are too large")
		}
		validated[index] = argument
	}
	return newConnectorSupervisor(store, options, validated)
}
