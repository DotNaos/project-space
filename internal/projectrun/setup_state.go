package projectrun

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type setupRuntimeState struct {
	Version           int        `json:"version"`
	Directory         string     `json:"directory"`
	StepID            string     `json:"stepId"`
	State             SetupState `json:"state"`
	Commit            string     `json:"commit"`
	DeclarationDigest string     `json:"declarationDigest"`
	PID               int        `json:"pid,omitempty"`
	ProcessIdentity   string     `json:"processIdentity,omitempty"`
	StartedAt         string     `json:"startedAt,omitempty"`
	FinishedAt        string     `json:"finishedAt,omitempty"`
	CheckedAt         string     `json:"checkedAt"`
	LastError         string     `json:"lastError,omitempty"`
}

func (store *stateStore) loadSetup(directory, stepID string) (setupRuntimeState, bool, error) {
	body, err := os.ReadFile(store.setupStatePath(directory, stepID))
	if errors.Is(err, os.ErrNotExist) {
		return setupRuntimeState{}, false, nil
	}
	if err != nil {
		return setupRuntimeState{}, false, fmt.Errorf("read setup state: %w", err)
	}
	state := setupRuntimeState{}
	if err := json.Unmarshal(body, &state); err != nil {
		return setupRuntimeState{}, false, fmt.Errorf("parse setup state: %w", err)
	}
	if state.Version != SchemaVersion || state.Directory != directory || state.StepID != stepID {
		return setupRuntimeState{}, false, fmt.Errorf("setup state identity is invalid")
	}
	return state, true, nil
}

func (store *stateStore) saveSetup(state setupRuntimeState) error {
	state.Version = SchemaVersion
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode setup state: %w", err)
	}
	path := store.setupStatePath(state.Directory, state.StepID)
	temporary, err := os.CreateTemp(filepath.Dir(path), ".state-*.json")
	if err != nil {
		return fmt.Errorf("create temporary setup state: %w", err)
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect temporary setup state: %w", err)
	}
	if _, err := temporary.Write(body); err != nil {
		temporary.Close()
		return fmt.Errorf("write temporary setup state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync temporary setup state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary setup state: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("publish setup state: %w", err)
	}
	return nil
}

func (store *stateStore) setupStatePath(directory, stepID string) string {
	return filepath.Join(store.root, "setup-states", sessionKey(directory, stepID)+".json")
}

func (store *stateStore) setupLockPath(directory, stepID string) string {
	return filepath.Join(store.root, "locks", "setup-"+sessionKey(directory, stepID)+".lock")
}

func (store *stateStore) setupLogPath(directory, stepID string) string {
	return filepath.Join(store.root, "setup-logs", sessionKey(directory, stepID)+".log")
}
