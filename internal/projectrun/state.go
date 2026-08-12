package projectrun

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
)

type runtimeState struct {
	Version            int       `json:"schemaVersion"`
	ServerID           string    `json:"serverId"`
	RepositoryPath     string    `json:"repositoryPath"`
	Directory          string    `json:"directory"`
	RequestedDirectory string    `json:"requestedDirectory,omitempty"`
	Script             string    `json:"script"`
	Mode               ServeMode `json:"mode"`
	APIs               APIsMode  `json:"apis"`
	Data               DataMode  `json:"data"`
	State              State     `json:"state"`
	Generation         string    `json:"generation"`
	TmuxSession        string    `json:"tmuxSession"`
	TmuxOwnershipToken string    `json:"tmuxOwnershipToken"`
	WorkspaceID        string    `json:"workspaceId,omitempty"`
	RuntimeGeneration  string    `json:"runtimeGeneration,omitempty"`
	PID                int       `json:"pid,omitempty"`
	ProcessID          string    `json:"processIdentity,omitempty"`
	LocalPort          int       `json:"localPort,omitempty"`
	PortlessName       string    `json:"portlessName,omitempty"`
	PortlessURL        string    `json:"portlessUrl,omitempty"`
	PublicPort         int       `json:"publicPort,omitempty"`
	TailscaleIPv4      string    `json:"tailscaleIPv4,omitempty"`
	AllowedHosts       []string  `json:"allowedHosts"`
	StartedAt          string    `json:"startedAt,omitempty"`
	CheckedAt          string    `json:"checkedAt"`
	LastError          string    `json:"lastError,omitempty"`
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
		filepath.Join(resolved, "requests"),
		filepath.Join(resolved, "simulations"),
		filepath.Join(resolved, "setup-states"),
		filepath.Join(resolved, "setup-logs"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, fmt.Errorf("create runtime directory %q: %w", directory, err)
		}
	}
	return &stateStore{root: resolved}, nil
}

func (store *stateStore) simulationStatePath(serverID string) string {
	return filepath.Join(store.root, "simulations", serverID+".json")
}

func sessionKey(directory, script string) string {
	sum := sha256.Sum256([]byte(directory + "\x00" + script))
	return hex.EncodeToString(sum[:16])
}

func (store *stateStore) load(identity ServerIdentity) (runtimeState, bool, error) {
	body, err := os.ReadFile(store.statePath(identity.ServerID))
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
	normalizeRuntimeStateBindings(&state)
	if err := validateRuntimeState(state); err != nil {
		return runtimeState{}, false, fmt.Errorf("serve state is invalid: %w", err)
	}
	if state.ServerID != identity.ServerID ||
		state.RepositoryPath != identity.RepositoryPath || state.Directory != identity.WorktreePath ||
		state.Script != identity.ServerKey || state.TmuxSession != identity.TmuxSession {
		return runtimeState{}, false, fmt.Errorf("serve state identity is invalid")
	}
	return state, true, nil
}

func (store *stateStore) save(state runtimeState) error {
	state.Version = SchemaVersion
	if err := validateRuntimeState(state); err != nil {
		return fmt.Errorf("refuse invalid serve state: %w", err)
	}
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode serve state: %w", err)
	}
	path := store.statePath(state.ServerID)
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

func (store *stateStore) delete(serverID string) error {
	err := os.Remove(store.statePath(serverID))
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
		normalizeRuntimeStateBindings(&state)
		expectedName := state.ServerID + ".json"
		if validationErr := validateRuntimeState(state); validationErr != nil || entry.Name() != expectedName {
			listing.Failures = append(listing.Failures, fmt.Errorf(
				"serve state %q is invalid: %v", entry.Name(), validationErr,
			))
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

func normalizeRuntimeStateBindings(state *runtimeState) {
	if state.APIs == "" && state.Data == "" {
		// Sessions created before binding evidence existed always used the real
		// integrations and the connector's configured shared data services.
		state.APIs = APIsModeExternal
		state.Data = DataModeRemote
	}
}

func validateRuntimeState(state runtimeState) error {
	if state.Version != SchemaVersion {
		return fmt.Errorf("schema version %d is not supported", state.Version)
	}
	for name, value := range map[string]string{
		"server ID": state.ServerID, "repository path": state.RepositoryPath,
		"worktree path": state.Directory, "server key": state.Script,
		"tmux session": state.TmuxSession, "generation": state.Generation,
		"tmux ownership token": state.TmuxOwnershipToken,
	} {
		if strings.TrimSpace(value) == "" || len(value) > 4096 || strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("%s is invalid", name)
		}
	}
	if state.Mode != ServeModeManaged && state.Mode != ServeModeLocalOnly {
		return fmt.Errorf("mode %q is invalid", state.Mode)
	}
	if (state.WorkspaceID == "") != (state.RuntimeGeneration == "") {
		return fmt.Errorf("workspace and runtime generation bindings must be present together")
	}
	for name, value := range map[string]string{"workspace ID": state.WorkspaceID, "runtime generation": state.RuntimeGeneration} {
		if value != "" && (strings.TrimSpace(value) != value || len(value) > 128 || strings.ContainsAny(value, "\x00\r\n\t ")) {
			return fmt.Errorf("%s binding is invalid", name)
		}
	}
	if state.APIs != APIsModeSimulated && state.APIs != APIsModeExternal {
		return fmt.Errorf("APIs mode %q is invalid", state.APIs)
	}
	if state.Data != DataModeLocal && state.Data != DataModeRemote {
		return fmt.Errorf("data mode %q is invalid", state.Data)
	}
	if state.APIs == APIsModeSimulated && state.Data == DataModeRemote {
		return fmt.Errorf("simulated APIs cannot use remote data")
	}
	if !validRuntimeStatePhase(state.State) {
		return fmt.Errorf("state %q is invalid", state.State)
	}
	if state.State == StateRunning && state.Mode != ServeModeManaged {
		return fmt.Errorf("running state requires managed mode")
	}
	if state.State == StateLocalOnly && state.Mode != ServeModeLocalOnly {
		return fmt.Errorf("local-only state requires local-only mode")
	}
	if err := validateRuntimePort("local", state.LocalPort); err != nil {
		return err
	}
	if err := validateRuntimePort("public", state.PublicPort); err != nil {
		return err
	}
	if state.Mode == ServeModeLocalOnly && (state.PublicPort != 0 || state.TailscaleIPv4 != "") {
		return fmt.Errorf("local-only state contains Tailscale resources")
	}
	if state.Mode == ServeModeManaged && hasRuntimeResources(state) &&
		(state.PublicPort == 0 || net.ParseIP(state.TailscaleIPv4).To4() == nil) {
		return fmt.Errorf("managed runtime has no valid Tailscale port and IPv4 address")
	}
	if state.PortlessName != "" {
		if err := validatePortlessName(state.PortlessName); err != nil {
			return err
		}
	}
	if state.PortlessURL != "" {
		if err := validatePortlessRoute(state.PortlessName, state.PortlessURL); err != nil {
			return err
		}
	}
	if (state.State == StateRunning || state.State == StateLocalOnly || state.PID > 0) &&
		(state.PortlessName == "" || state.PortlessURL == "") {
		return fmt.Errorf("active runtime has no verified Portless route")
	}
	if state.PID < 0 || (state.PID == 0) != (state.ProcessID == "") {
		return fmt.Errorf("process identity is inconsistent")
	}
	if state.CheckedAt == "" {
		return fmt.Errorf("checked timestamp is missing")
	}
	if normalized, err := NormalizeAllowedHosts(state.AllowedHosts); err != nil ||
		!reflect.DeepEqual(normalized, state.AllowedHosts) {
		return fmt.Errorf("allowed hosts are not normalized")
	}
	return nil
}

func validRuntimeStatePhase(state State) bool {
	switch state {
	case StateStarting, StateRunning, StateLocalOnly, StateStopping, StateFailed, StateStale:
		return true
	default:
		return false
	}
}

func validateRuntimePort(name string, port int) error {
	if port < 0 || port > 65535 {
		return fmt.Errorf("%s port %d is invalid", name, port)
	}
	return nil
}

func (store *stateStore) statePath(serverID string) string {
	return filepath.Join(store.root, "sessions", serverID+".json")
}

func (store *stateStore) sessionLockPath(serverID string) string {
	return filepath.Join(store.root, "locks", "session-"+serverID+".lock")
}

func (store *stateStore) portLockPath() string {
	return filepath.Join(store.root, "locks", "ports.lock")
}

func (store *stateStore) tailnetLockPath() string {
	return filepath.Join(store.root, "locks", "tailnet.lock")
}

func (store *stateStore) portlessLockPath() string {
	return filepath.Join(store.root, "locks", "portless.lock")
}

func (store *stateStore) logPath(serverID string) string {
	return filepath.Join(store.root, "logs", serverID+".log")
}

func (store *stateStore) requestPath(serverID, generation string) string {
	return filepath.Join(store.root, "requests", serverID+"-"+generation+".json")
}

func (store *stateStore) deleteLog(serverID string) error {
	err := os.Remove(store.logPath(serverID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove serve log: %w", err)
	}
	return nil
}
