package workspacesession

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func (receiver *controlReceiver) activateTask(command controlCommand) (taskActivationSummary, error) {
	path := receiver.taskActivationPath()
	record := receiver.taskActivationRecord(command)
	if encoded, err := readProtected(path, 16*1024); err == nil {
		var existing taskActivationRecord
		if json.Unmarshal(encoded, &existing) != nil || existing != record {
			return taskActivationSummary{}, fmt.Errorf("Workspace task activation conflicts with the existing lease")
		}
		return taskActivationOutput(existing), nil
	} else if !os.IsNotExist(err) {
		return taskActivationSummary{}, err
	}
	if err := writeProtectedAtomic(path, record); err != nil {
		return taskActivationSummary{}, err
	}
	return taskActivationOutput(record), nil
}

func (receiver *controlReceiver) preflightTaskActivation(command controlCommand) error {
	encoded, err := readProtected(receiver.taskActivationPath(), 16*1024)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var existing taskActivationRecord
	if json.Unmarshal(encoded, &existing) != nil || existing != receiver.taskActivationRecord(command) {
		return fmt.Errorf("Workspace task activation conflicts with the existing lease")
	}
	return nil
}

func (receiver *controlReceiver) taskActivationRecord(command controlCommand) taskActivationRecord {
	return taskActivationRecord{
		Generation: receiver.bootstrap.Generation, OwnerUserID: receiver.bootstrap.OwnerUserID,
		TaskExecutionID: command.TaskExecutionID, WorkspaceID: receiver.bootstrap.WorkspaceID,
		WorkspaceLeaseID: command.WorkspaceLeaseID,
	}
}

func (receiver *controlReceiver) taskActivationPath() string {
	return filepath.Join(filepath.Dir(receiver.bootstrap.JournalPath), "runtime-task-activation.json")
}

func taskActivationOutput(record taskActivationRecord) taskActivationSummary {
	return taskActivationSummary{
		TaskExecutionID: record.TaskExecutionID, State: "ready_for_agent",
	}
}

func writeProtectedAtomic(path string, value interface{}) error {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > 16*1024 {
		return fmt.Errorf("protected mutation record is invalid")
	}
	directory := filepath.Dir(path)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("protected mutation directory is invalid")
	}
	temporary, err := os.CreateTemp(directory, ".mutation-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(encoded); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	// Publish without replacing anything that appeared after the read-only
	// preflight. The generation directory is private, but this remains an
	// ownership boundary against another same-UID process racing the runtime.
	if err := os.Link(temporaryPath, path); err != nil {
		return err
	}
	directoryFile, err := os.Open(directory)
	if err != nil {
		return err
	}
	err = directoryFile.Sync()
	return errors.Join(err, directoryFile.Close())
}
