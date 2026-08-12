package workspacesession

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const (
	controlJournalSchema       = "project-space.workspace-runtime-control-journal/v1"
	maximumControlCommands     = 32
	maximumControlJournalBytes = 1024 * 1024
)

type controlCommandRecord struct {
	Fingerprint string            `json:"fingerprint"`
	Responses   []controlResponse `json:"responses"`
	Sequence    int64             `json:"sequence"`
	State       string            `json:"state"`
}

type controlJournal struct {
	AcceptedCommandSequence int64                  `json:"acceptedCommandSequence"`
	AcceptedEventSequence   int64                  `json:"acceptedEventSequence"`
	BindingDigest           string                 `json:"bindingDigest"`
	Commands                []controlCommandRecord `json:"commands"`
	LastEventSequence       int64                  `json:"lastEventSequence"`
	Schema                  string                 `json:"schema"`
}

func (state *controlJournal) command(sequence int64) *controlCommandRecord {
	for index := range state.Commands {
		if state.Commands[index].Sequence == sequence {
			return &state.Commands[index]
		}
	}
	return nil
}

func loadControlJournal(path, bindingDigest string) (controlJournal, error) {
	encoded, err := readProtected(path, maximumControlJournalBytes)
	if os.IsNotExist(err) {
		return controlJournal{BindingDigest: bindingDigest, Commands: []controlCommandRecord{}, Schema: controlJournalSchema}, nil
	}
	if err != nil {
		return controlJournal{}, err
	}
	var state controlJournal
	if json.Unmarshal(encoded, &state) != nil || validateControlJournal(state) != nil || state.BindingDigest != bindingDigest {
		return controlJournal{}, fmt.Errorf("Workspace Runtime control journal is invalid")
	}
	return state, nil
}

func saveControlJournal(path string, state controlJournal) error {
	if err := validateControlJournal(state); err != nil {
		return err
	}
	encoded, err := json.Marshal(state)
	if err != nil || len(encoded) > maximumControlJournalBytes {
		return fmt.Errorf("Workspace Runtime control journal is too large")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("Workspace Runtime control journal directory is not protected")
	}
	temporary, err := os.CreateTemp(directory, ".runtime-control-journal-*")
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
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		directoryFile, err := os.Open(directory)
		if err != nil {
			return err
		}
		err = directoryFile.Sync()
		closeErr := directoryFile.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func validateControlJournal(state controlJournal) error {
	if state.Schema != controlJournalSchema || len(state.BindingDigest) != 64 ||
		state.AcceptedCommandSequence < 0 || state.AcceptedEventSequence < 0 ||
		state.LastEventSequence < state.AcceptedEventSequence || len(state.Commands) > maximumControlCommands {
		return fmt.Errorf("Workspace Runtime control journal is invalid")
	}
	previous := int64(0)
	previousEvent := int64(0)
	for _, record := range state.Commands {
		if record.Sequence < 1 || record.Sequence <= previous || record.Sequence > state.AcceptedCommandSequence ||
			len(record.Fingerprint) != 64 || !oneOf(record.State, "completed", "uncertain") ||
			len(record.Responses) < 1 || len(record.Responses) > 2 {
			return fmt.Errorf("Workspace Runtime control journal is invalid")
		}
		for _, response := range record.Responses {
			if response.EventSequence == nil || *response.EventSequence < 1 ||
				*response.EventSequence > state.LastEventSequence || *response.EventSequence <= previousEvent ||
				response.CommandSequence != record.Sequence {
				return fmt.Errorf("Workspace Runtime control journal is invalid")
			}
			previousEvent = *response.EventSequence
		}
		accepted := record.Responses[0]
		if accepted.Type != "runtime.control.command-accepted" || accepted.AcceptedCommandSequence == nil ||
			*accepted.AcceptedCommandSequence != record.Sequence || accepted.Replayed == nil ||
			len(record.Responses) == 1 && record.State != "uncertain" ||
			len(record.Responses) == 2 && !oneOf(record.Responses[1].Type, "runtime.control.result", "runtime.control.error") {
			return fmt.Errorf("Workspace Runtime control journal is invalid")
		}
		previous = record.Sequence
	}
	if len(state.Commands) > 0 && previousEvent != state.LastEventSequence {
		return fmt.Errorf("Workspace Runtime control journal is invalid")
	}
	return nil
}
