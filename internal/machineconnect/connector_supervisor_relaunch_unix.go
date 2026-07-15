//go:build !windows

package machineconnect

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// ResolveConnectorSupervisorRelaunchExecutable derives the trusted current
// Project CLI from a managed companion. It never accepts a caller-selected
// release, path, or command.
func ResolveConnectorSupervisorRelaunchExecutable(
	connectorExecutable string,
) (string, error) {
	toolsRoot, managed := possibleConnectorSupervisorToolsRoot(connectorExecutable)
	if !managed {
		return "", errors.New("connector supervisor is not running from a managed release")
	}
	resolvedConnector, err := filepath.EvalSymlinks(filepath.Clean(connectorExecutable))
	if err != nil || filepath.Base(resolvedConnector) != "project-space-connector" {
		return "", errors.New("managed connector supervisor executable is invalid")
	}
	versionsRoot := filepath.Join(toolsRoot, connectorSupervisorVersionsDirectoryName)
	pointer, err := readManagedPointer(
		filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName),
		versionsRoot,
	)
	if err != nil {
		return "", maintenanceError("managed-supervisor-unavailable", err)
	}
	projectExecutable := filepath.Join(
		versionsRoot,
		filepath.Base(pointer),
		"project",
	)
	info, err := os.Lstat(projectExecutable)
	if err != nil || info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() ||
		info.Mode().Perm()&0o111 == 0 || info.Mode().Perm()&0o022 != 0 {
		return "", maintenanceError(
			"managed-supervisor-unavailable",
			errors.New("managed Project CLI is not a trusted executable regular file"),
		)
	}
	return projectExecutable, nil
}
