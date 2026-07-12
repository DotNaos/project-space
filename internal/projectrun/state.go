package projectrun

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type runtimeState struct {
	Version            int      `json:"version"`
	Directory          string   `json:"directory"`
	RequestedDirectory string   `json:"requestedDirectory,omitempty"`
	Script             string   `json:"script"`
	State              State    `json:"state"`
	PID                int      `json:"pid,omitempty"`
	ProcessID          string   `json:"processIdentity,omitempty"`
	LocalPort          int      `json:"localPort,omitempty"`
	PublicPort         int      `json:"publicPort,omitempty"`
	TailscaleIPv4      string   `json:"tailscaleIPv4,omitempty"`
	AllowedHosts       []string `json:"allowedHosts"`
	StartedAt          string   `json:"startedAt,omitempty"`
	CheckedAt          string   `json:"checkedAt"`
	LastError          string   `json:"lastError,omitempty"`
}

type stateStore struct {
	root string
}

type stateListing struct {
	States   []runtimeState
	Failures []error
}

func defaultStateRoot() (string, error) {
	if override := strings.TrimSpace(os.Getenv("PROJECT_SPACE_RUNTIME_DIR")); override != "" {
		return filepath.Abs(override)
	}
	if stateHome := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); stateHome != "" {
		return filepath.Join(stateHome, "project-space", "serve"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home directory: %w", err)
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Project Space", "serve"), nil
	}
	return filepath.Join(home, ".local", "state", "project-space", "serve"), nil
}

func newStateStore(root string) (*stateStore, error) {
	resolved, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve runtime directory: %w", err)
	}
	for _, directory := range []string{
		resolved,
		filepath.Join(resolved, "sessions"),
		filepath.Join(resolved, "locks"),
		filepath.Join(resolved, "logs"),
		filepath.Join(resolved, "setup-states"),
		filepath.Join(resolved, "setup-logs"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, fmt.Errorf("create runtime directory %q: %w", directory, err)
		}
	}
	return &stateStore{root: resolved}, nil
}

func sessionKey(directory, script string) string {
	sum := sha256.Sum256([]byte(directory + "\x00" + script))
	return hex.EncodeToString(sum[:16])
}

func (store *stateStore) load(directory, script string) (runtimeState, bool, error) {
	body, err := os.ReadFile(store.statePath(directory, script))
	if errors.Is(err, os.ErrNotExist) {
		return runtimeState{}, false, nil
	}
	if err != nil {
		return runtimeState{}, false, fmt.Errorf("read serve state: %w", err)
	}
	state := runtimeState{}
	if err := json.Unmarshal(body, &state); err != nil {
		return runtimeState{}, false, fmt.Errorf("parse serve state: %w", err)
	}
	if state.Version != SchemaVersion || state.Directory != directory || state.Script != script {
		return runtimeState{}, false, fmt.Errorf("serve state identity is invalid")
	}
	return state, true, nil
}

func (store *stateStore) save(state runtimeState) error {
	state.Version = SchemaVersion
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode serve state: %w", err)
	}
	path := store.statePath(state.Directory, state.Script)
	temporary, err := os.CreateTemp(filepath.Dir(path), ".state-*.json")
	if err != nil {
		return fmt.Errorf("create temporary serve state: %w", err)
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect temporary serve state: %w", err)
	}
	if _, err := temporary.Write(body); err != nil {
		temporary.Close()
		return fmt.Errorf("write temporary serve state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync temporary serve state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary serve state: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("publish serve state: %w", err)
	}
	return nil
}

func (store *stateStore) delete(directory, script string) error {
	err := os.Remove(store.statePath(directory, script))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove serve state: %w", err)
	}
	return nil
}

func (store *stateStore) list() (stateListing, error) {
	entries, err := os.ReadDir(filepath.Join(store.root, "sessions"))
	if err != nil {
		return stateListing{}, fmt.Errorf("list serve states: %w", err)
	}
	listing := stateListing{States: make([]runtimeState, 0, len(entries))}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" || strings.HasPrefix(entry.Name(), ".state-") {
			continue
		}
		path := filepath.Join(store.root, "sessions", entry.Name())
		info, err := entry.Info()
		if err != nil {
			listing.Failures = append(listing.Failures, fmt.Errorf("inspect serve state %q: %w", entry.Name(), err))
			continue
		}
		if !info.Mode().IsRegular() {
			listing.Failures = append(listing.Failures, fmt.Errorf("serve state %q is not a regular file", entry.Name()))
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil {
			listing.Failures = append(listing.Failures, fmt.Errorf("read serve state %q: %w", entry.Name(), err))
			continue
		}
		state := runtimeState{}
		if err := json.Unmarshal(body, &state); err != nil {
			listing.Failures = append(listing.Failures, fmt.Errorf("parse serve state %q: %w", entry.Name(), err))
			continue
		}
		expectedName := sessionKey(state.Directory, state.Script) + ".json"
		if state.Version != SchemaVersion || state.Directory == "" || state.Script == "" || entry.Name() != expectedName {
			listing.Failures = append(listing.Failures, fmt.Errorf("serve state %q has an invalid identity", entry.Name()))
			continue
		}
		listing.States = append(listing.States, state)
	}
	sort.Slice(listing.States, func(i, j int) bool {
		return listing.States[i].Directory+listing.States[i].Script <
			listing.States[j].Directory+listing.States[j].Script
	})
	return listing, nil
}

func (store *stateStore) statePath(directory, script string) string {
	return filepath.Join(store.root, "sessions", sessionKey(directory, script)+".json")
}

func (store *stateStore) sessionLockPath(directory, script string) string {
	return filepath.Join(store.root, "locks", "session-"+sessionKey(directory, script)+".lock")
}

func (store *stateStore) portLockPath() string {
	return filepath.Join(store.root, "locks", "ports.lock")
}

func (store *stateStore) tailnetLockPath() string {
	return filepath.Join(store.root, "locks", "tailnet.lock")
}

func (store *stateStore) logPath(directory, script string) string {
	return filepath.Join(store.root, "logs", sessionKey(directory, script)+".log")
}

func (store *stateStore) deleteLog(directory, script string) error {
	err := os.Remove(store.logPath(directory, script))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove serve log: %w", err)
	}
	return nil
}
