package machineconnect

import (
	"errors"
	"regexp"
)

const (
	ConnectorRuntimeBuildIDEnv   = "PROJECT_SPACE_BUILD_ID"
	ConnectorRuntimeReleaseIDEnv = "PROJECT_SPACE_RELEASE_ID"
)

var (
	connectorSupervisorCompiledBuildIDPattern   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	connectorSupervisorCompiledReleaseIDPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
)

type ConnectorSupervisorBuildIdentity struct {
	BuildID   string
	ReleaseID string
}

func validateConnectorSupervisorBuildIdentity(identity ConnectorSupervisorBuildIdentity) error {
	if identity == (ConnectorSupervisorBuildIdentity{}) {
		return nil
	}
	if identity.BuildID == "unknown" && identity.ReleaseID == "dev" {
		return nil
	}
	if !connectorSupervisorCompiledBuildIDPattern.MatchString(identity.BuildID) ||
		!connectorSupervisorCompiledReleaseIDPattern.MatchString(identity.ReleaseID) {
		return errors.New("connector supervisor build identity is invalid")
	}
	return nil
}

func connectorSupervisorBuildEnvironment(
	identity ConnectorSupervisorBuildIdentity,
) []string {
	if identity == (ConnectorSupervisorBuildIdentity{}) {
		return nil
	}
	return []string{
		ConnectorRuntimeBuildIDEnv + "=" + identity.BuildID,
		ConnectorRuntimeReleaseIDEnv + "=" + identity.ReleaseID,
	}
}
