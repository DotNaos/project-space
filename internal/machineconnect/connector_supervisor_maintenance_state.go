package machineconnect

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type connectorSupervisorMaintenancePhase string

const (
	connectorSupervisorPhaseSwitching     connectorSupervisorMaintenancePhase = "switching"
	connectorSupervisorPhasePendingHealth connectorSupervisorMaintenancePhase = "pending-health-check"
	connectorSupervisorPhaseRolledBack    connectorSupervisorMaintenancePhase = "rolled-back"
	connectorSupervisorPhaseFailed        connectorSupervisorMaintenancePhase = "failed"
	connectorSupervisorPhaseRecovery      connectorSupervisorMaintenancePhase = "recovery-required"
)

type connectorSupervisorMaintenanceState struct {
	DeadlineAt      string                                  `json:"deadlineAt"`
	ExpectedRuntime ConnectorSupervisorRuntimeFingerprint   `json:"expectedRuntime"`
	FailureCode     string                                  `json:"failureCode,omitempty"`
	NextPointer     string                                  `json:"nextPointer"`
	Operation       ConnectorSupervisorMaintenanceOperation `json:"operation"`
	OperationID     string                                  `json:"operationId"`
	Phase           connectorSupervisorMaintenancePhase     `json:"phase"`
	PreviousPointer string                                  `json:"previousPointer"`
	PreviousRuntime ConnectorSupervisorRuntimeFingerprint   `json:"previousRuntime"`
	Schema          string                                  `json:"schema"`
	StartedAt       string                                  `json:"startedAt"`
	Target          string                                  `json:"target"`
}

var managedPointerComponentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$`)

func (maintenance *ConnectorSupervisorMaintenance) ensureDirectories() error {
	info, err := os.Lstat(maintenance.paths.ToolsRoot)
	if err != nil {
		return maintenanceError("unmanaged-installation", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
		return maintenanceError("unsafe-tools-root", errors.New("tools root is not a directory"))
	}
	if err := ensureConnectorSupervisorPrivateDirectory(maintenance.paths.VersionsRoot); err != nil {
		return maintenanceError("unsafe-versions-root", err)
	}
	if err := ensureConnectorSupervisorPrivateDirectory(maintenance.paths.MaintenanceRoot); err != nil {
		return maintenanceError("unsafe-state-root", err)
	}
	if err := ensureConnectorSupervisorPrivateDirectory(maintenance.paths.StagingRoot); err != nil {
		return maintenanceError("unsafe-staging-root", err)
	}
	return nil
}

func ensureConnectorSupervisorPrivateDirectory(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("private path is not a directory")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("private directory is accessible by another user")
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return err
	}
	return nil
}

func readConnectorSupervisorPrivateFile(path string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("private state path is not a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("private state file is accessible by another user")
	}
	if info.Size() < 1 || info.Size() > maximum {
		return nil, errors.New("private state file size is invalid")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		return nil, errors.New("private state file changed while opening")
	}
	body, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maximum {
		return nil, errors.New("private state file is too large")
	}
	return body, nil
}

func writeConnectorSupervisorPrivateJSON(path string, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	directory := filepath.Dir(path)
	if existing, err := os.Lstat(path); err == nil {
		if existing.Mode()&fs.ModeSymlink != 0 || !existing.Mode().IsRegular() {
			return errors.New("refusing to replace unsafe private state path")
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".maintenance-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	closed := false
	defer func() {
		if !closed {
			_ = temporary.Close()
		}
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(body); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		closed = true
		return err
	}
	closed = true
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	return syncConnectorSupervisorDirectory(directory)
}

func syncConnectorSupervisorDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (maintenance *ConnectorSupervisorMaintenance) readState() (
	connectorSupervisorMaintenanceState,
	error,
) {
	body, err := readConnectorSupervisorPrivateFile(
		maintenance.paths.StateFile,
		maximumConnectorSupervisorStateBytes,
	)
	if err != nil {
		return connectorSupervisorMaintenanceState{}, err
	}
	var state connectorSupervisorMaintenanceState
	if err := decodeConnectorSupervisorJSON(body, &state); err != nil {
		return connectorSupervisorMaintenanceState{}, err
	}
	if err := validateConnectorSupervisorState(state); err != nil {
		return connectorSupervisorMaintenanceState{}, err
	}
	return state, nil
}

func (maintenance *ConnectorSupervisorMaintenance) writeState(
	state connectorSupervisorMaintenanceState,
) error {
	if err := validateConnectorSupervisorState(state); err != nil {
		return err
	}
	return writeConnectorSupervisorPrivateJSON(maintenance.paths.StateFile, state)
}

func (maintenance *ConnectorSupervisorMaintenance) removeState() error {
	if err := removeIfExists(maintenance.paths.StateFile); err != nil {
		return err
	}
	return syncConnectorSupervisorDirectory(maintenance.paths.MaintenanceRoot)
}

func validateConnectorSupervisorState(state connectorSupervisorMaintenanceState) error {
	if state.Schema != ConnectorSupervisorMaintenanceStateSchema ||
		!validConnectorSupervisorIdentifier(state.OperationID, 256) ||
		(state.Operation != ConnectorSupervisorMaintenanceRestart &&
			state.Operation != ConnectorSupervisorMaintenanceUpdate) ||
		!validConnectorSupervisorTarget(state.Target) ||
		!validManagedPointer(state.PreviousPointer) || !validManagedPointer(state.NextPointer) ||
		!validConnectorSupervisorFingerprint(state.PreviousRuntime, false) ||
		!validConnectorSupervisorFingerprint(state.ExpectedRuntime, true) {
		return errors.New("connector supervisor maintenance state is invalid")
	}
	startedAt, err := time.Parse(time.RFC3339Nano, state.StartedAt)
	if err != nil || startedAt.Format(time.RFC3339Nano) != state.StartedAt {
		return errors.New("connector supervisor maintenance start time is invalid")
	}
	deadlineAt, err := time.Parse(time.RFC3339Nano, state.DeadlineAt)
	if err != nil || deadlineAt.Format(time.RFC3339Nano) != state.DeadlineAt ||
		!deadlineAt.After(startedAt) || deadlineAt.Sub(startedAt) > 30*time.Minute {
		return errors.New("connector supervisor maintenance deadline is invalid")
	}
	validPhase := state.Phase == connectorSupervisorPhaseSwitching ||
		state.Phase == connectorSupervisorPhasePendingHealth ||
		state.Phase == connectorSupervisorPhaseRolledBack ||
		state.Phase == connectorSupervisorPhaseFailed ||
		state.Phase == connectorSupervisorPhaseRecovery
	if !validPhase {
		return errors.New("connector supervisor maintenance phase is invalid")
	}
	if state.Operation == ConnectorSupervisorMaintenanceRestart &&
		state.PreviousPointer != state.NextPointer {
		return errors.New("connector supervisor restart state changed the managed pointer")
	}
	if (state.Phase == connectorSupervisorPhaseFailed ||
		state.Phase == connectorSupervisorPhaseRecovery) != (state.FailureCode != "") ||
		(state.FailureCode != "" && !validConnectorSupervisorIdentifier(state.FailureCode, 64)) {
		return errors.New("connector supervisor maintenance failure state is invalid")
	}
	return nil
}

func validManagedPointer(value string) bool {
	if strings.Contains(value, "\\") || filepath.IsAbs(value) || filepath.Clean(value) != value {
		return false
	}
	parts := strings.Split(filepath.ToSlash(value), "/")
	return len(parts) == 2 && parts[0] == connectorSupervisorVersionsDirectoryName &&
		managedPointerComponentPattern.MatchString(parts[1]) && parts[1] != "." && parts[1] != ".."
}

func readManagedPointer(path, versionsRoot string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.Mode()&fs.ModeSymlink == 0 {
		return "", errors.New("managed current pointer is not a symbolic link")
	}
	target, err := os.Readlink(path)
	if err != nil || !validManagedPointer(target) {
		return "", errors.New("managed current pointer target is invalid")
	}
	versionDirectory := filepath.Join(versionsRoot, filepath.Base(target))
	versionInfo, err := os.Lstat(versionDirectory)
	if err != nil || versionInfo.Mode()&fs.ModeSymlink != 0 || !versionInfo.IsDir() ||
		versionInfo.Mode().Perm()&0o077 != 0 {
		return "", errors.New("managed current version is unavailable")
	}
	return target, nil
}

func switchManagedPointer(currentPath, toolsRoot, versionsRoot, target string) error {
	if !validManagedPointer(target) {
		return errors.New("managed pointer target is invalid")
	}
	versionPath := filepath.Join(versionsRoot, filepath.Base(target))
	info, err := os.Lstat(versionPath)
	if err != nil || info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("managed pointer target is unavailable")
	}
	temporary, err := os.CreateTemp(toolsRoot, ".current-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		return err
	}
	defer os.Remove(temporaryPath)
	if err := os.Symlink(target, temporaryPath); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, currentPath); err != nil {
		return err
	}
	return syncConnectorSupervisorDirectory(toolsRoot)
}

func encodeConnectorSupervisorStateForTest(state connectorSupervisorMaintenanceState) []byte {
	body, _ := json.Marshal(state)
	return bytes.TrimSpace(body)
}

func stateError(code string, cause error) error {
	return maintenanceError(code, fmt.Errorf("maintenance state: %w", cause))
}
