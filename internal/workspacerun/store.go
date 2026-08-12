package workspacerun

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maximumStateBytes = 256 << 10

type runtimeRecord struct {
	Version            int                `json:"schemaVersion"`
	WorkspaceID        string             `json:"workspaceId"`
	Repository         string             `json:"repository"`
	Directory          string             `json:"directory"`
	GitDirectory       string             `json:"gitDirectory"`
	Branch             string             `json:"branch"`
	Head               string             `json:"head"`
	IdentityProof      string             `json:"identityProof"`
	ManifestDigest     string             `json:"manifestDigest"`
	Mode               Mode               `json:"mode"`
	State              RuntimeState       `json:"state"`
	Generation         string             `json:"generation"`
	OwnershipToken     string             `json:"ownershipToken"`
	Handle             RuntimeHandle      `json:"handle"`
	Resources          ResourceLimits     `json:"resources"`
	DevServers         []ManagedDevServer `json:"devServers"`
	ExpectedDevServers []string           `json:"expectedDevServers"`
	Shutdown           []string           `json:"shutdown"`
	StartedAt          string             `json:"startedAt,omitempty"`
	CheckedAt          string             `json:"checkedAt"`
	LastError          string             `json:"lastError,omitempty"`
}

func (record runtimeRecord) binding() RuntimeBinding {
	return RuntimeBinding{
		WorkspaceID: record.WorkspaceID, Generation: record.Generation,
		ManifestDigest: record.ManifestDigest, OwnershipToken: record.OwnershipToken,
	}
}

type stateStore struct {
	root string
	mu   sync.Mutex
}

func defaultStateRoot() (string, error) {
	if override := strings.TrimSpace(os.Getenv("PROJECT_SPACE_WORKSPACE_RUNTIME_DIR")); override != "" {
		return filepath.Abs(override)
	}
	if stateHome := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); stateHome != "" {
		return filepath.Join(stateHome, "project-space", "workspace-runtimes"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home directory: %w", err)
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Project Space", "workspace-runtimes"), nil
	}
	return filepath.Join(home, ".local", "state", "project-space", "workspace-runtimes"), nil
}

func newStateStore(root string) (*stateStore, error) {
	resolved, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace runtime directory: %w", err)
	}
	for _, directory := range []string{
		resolved, filepath.Join(resolved, "states"), filepath.Join(resolved, "locks"),
		filepath.Join(resolved, "logs"), filepath.Join(resolved, "generations"),
	} {
		if err := ensurePrivateDirectory(directory); err != nil {
			return nil, err
		}
	}
	return &stateStore{root: resolved}, nil
}

func ensurePrivateDirectory(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("workspace runtime path %q is not a regular directory", path)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create workspace runtime directory %q: %w", path, err)
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("protect workspace runtime directory %q: %w", path, err)
	}
	return nil
}

func (store *stateStore) load(identity WorkspaceIdentity) (runtimeRecord, bool, error) {
	path := store.statePath(identity.WorkspaceID)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return runtimeRecord{}, false, nil
	}
	if err != nil {
		return runtimeRecord{}, false, fmt.Errorf("inspect workspace runtime state: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() > maximumStateBytes || info.Mode().Perm()&0o077 != 0 {
		return runtimeRecord{}, false, fmt.Errorf("workspace runtime state must be a private bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return runtimeRecord{}, false, fmt.Errorf("read workspace runtime state: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return runtimeRecord{}, false, fmt.Errorf("workspace runtime state changed while opening")
	}
	record := runtimeRecord{}
	decoder := json.NewDecoder(io.LimitReader(file, maximumStateBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return runtimeRecord{}, false, fmt.Errorf("parse workspace runtime state: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return runtimeRecord{}, false, fmt.Errorf("workspace runtime state must contain exactly one JSON value")
	}
	if err := validateRecord(record, identity); err != nil {
		return runtimeRecord{}, false, fmt.Errorf("workspace runtime state is invalid: %w", err)
	}
	return record, true, nil
}

func (store *stateStore) save(record runtimeRecord) error {
	identity := WorkspaceIdentity{
		WorkspaceID: record.WorkspaceID, Repository: record.Repository, Directory: record.Directory,
		GitDirectory: record.GitDirectory, Branch: record.Branch, Head: record.Head,
		IdentityProof: record.IdentityProof,
	}
	if err := validateRecord(record, identity); err != nil {
		return err
	}
	body, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return fmt.Errorf("encode workspace runtime state: %w", err)
	}
	body = append(body, '\n')
	if len(body) > maximumStateBytes {
		return fmt.Errorf("workspace runtime state exceeds the %d-byte limit", maximumStateBytes)
	}
	temporary, err := os.CreateTemp(filepath.Join(store.root, "states"), ".runtime-*.json")
	if err != nil {
		return fmt.Errorf("create workspace runtime state: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("protect workspace runtime state: %w", err)
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write workspace runtime state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync workspace runtime state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close workspace runtime state: %w", err)
	}
	if err := os.Rename(temporaryPath, store.statePath(record.WorkspaceID)); err != nil {
		return fmt.Errorf("publish workspace runtime state: %w", err)
	}
	return syncDirectory(filepath.Join(store.root, "states"))
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (store *stateStore) remove(workspaceID string) error {
	if !workspaceIDPattern.MatchString(workspaceID) {
		return fmt.Errorf("workspace ID is invalid")
	}
	var failures []error
	for _, path := range []string{store.statePath(workspaceID), store.logPath(workspaceID)} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (store *stateStore) removeGeneration(workspaceID, generation string) error {
	if !workspaceIDPattern.MatchString(workspaceID) || !uuidPattern.MatchString(generation) {
		return fmt.Errorf("runtime generation identity is invalid")
	}
	root := filepath.Join(store.root, "generations")
	parent := filepath.Join(root, workspaceID)
	parentInfo, err := os.Lstat(parent)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return fmt.Errorf("runtime Workspace generation parent is not an owned directory")
	}
	target := filepath.Join(root, workspaceID, generation)
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == "." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("runtime generation path escapes its state root")
	}
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect runtime generation directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("runtime generation path is not an owned directory")
	}
	if err := os.RemoveAll(target); err != nil {
		return fmt.Errorf("remove runtime generation directory: %w", err)
	}
	return nil
}

func (store *stateStore) prepareGeneration(workspaceID, generation string) error {
	if !workspaceIDPattern.MatchString(workspaceID) || !uuidPattern.MatchString(generation) {
		return fmt.Errorf("runtime generation identity is invalid")
	}
	for _, directory := range []string{
		filepath.Join(store.root, "generations", workspaceID),
		filepath.Join(store.root, "generations", workspaceID, generation),
	} {
		if err := ensurePrivateDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}

func (store *stateStore) generationHome(workspaceID, generation string) string {
	return filepath.Join(store.root, "generations", workspaceID, generation)
}

func (store *stateStore) withLock(workspaceID string, action func() error) error {
	if !workspaceIDPattern.MatchString(workspaceID) {
		return fmt.Errorf("workspace ID is invalid")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	file, err := os.OpenFile(filepath.Join(store.root, "locks", workspaceID+".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open workspace runtime lock: %w", err)
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("protect workspace runtime lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("acquire workspace runtime lock: %w", err)
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return action()
}

func (store *stateStore) statePath(workspaceID string) string {
	return filepath.Join(store.root, "states", workspaceID+".json")
}
func (store *stateStore) logPath(workspaceID string) string {
	return filepath.Join(store.root, "logs", workspaceID+".log")
}

func validateRecord(record runtimeRecord, identity WorkspaceIdentity) error {
	if record.Version != SchemaVersion {
		return fmt.Errorf("schemaVersion must be %d", SchemaVersion)
	}
	if !workspaceIDPattern.MatchString(record.WorkspaceID) || !uuidPattern.MatchString(record.Generation) || !tokenPattern.MatchString(record.OwnershipToken) || !sha256Pattern.MatchString(record.ManifestDigest) || !sha256Pattern.MatchString(record.IdentityProof) {
		return fmt.Errorf("runtime identity fields are invalid")
	}
	if record.WorkspaceID != identity.WorkspaceID || record.Repository != identity.Repository || record.Directory != identity.Directory ||
		record.GitDirectory != identity.GitDirectory || record.Branch != identity.Branch || record.IdentityProof != identity.IdentityProof {
		return fmt.Errorf("Workspace identity binding does not match the exact checkout")
	}
	if !fullObjectID(record.Head) || record.Mode != ModeProcess && record.Mode != ModeDevcontainer {
		return fmt.Errorf("Workspace checkout or mode binding is invalid")
	}
	switch record.State {
	case StateStarting, StateRunning, StateSuspending, StateSuspended, StateResuming, StateStopping, StateStopped, StateCleaning, StateStale, StateFailed:
	default:
		return fmt.Errorf("state is invalid")
	}
	if record.CheckedAt == "" {
		return fmt.Errorf("checkedAt is required")
	}
	if _, err := time.Parse(time.RFC3339Nano, record.CheckedAt); err != nil {
		return fmt.Errorf("checkedAt is invalid")
	}
	if record.StartedAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, record.StartedAt); err != nil {
			return fmt.Errorf("startedAt is invalid")
		}
	}
	if err := validateHandle(record); err != nil {
		return err
	}
	if err := validateDevServers(record); err != nil {
		return err
	}
	return nil
}

func validateHandle(record runtimeRecord) error {
	empty := record.Handle.Kind == "" && record.Handle.Process == nil && record.Handle.Container == nil
	if record.State == StateFailed {
		if !empty || len(record.DevServers) != 0 {
			return fmt.Errorf("failed runtime state must not retain resource handles")
		}
		return nil
	}
	if (record.State == StateStopped || record.State == StateCleaning) && len(record.DevServers) != 0 {
		return fmt.Errorf("stopped runtime state must not retain dev servers")
	}
	if empty && (record.State == StateStopped || record.State == StateCleaning) {
		return nil
	}
	if empty && (record.State == StateStarting || record.State == StateStale) {
		return nil
	}
	switch record.Handle.Kind {
	case ResourceProcess:
		if record.Handle.Process == nil || record.Handle.Container != nil || record.Handle.Process.PID <= 0 || !sha256Pattern.MatchString(record.Handle.Process.Identity) || record.Handle.Process.BindingDigest != bindingDigest(record.binding()) {
			return fmt.Errorf("process handle is invalid")
		}
		if record.Mode != ModeProcess || !record.Resources.Empty() {
			return fmt.Errorf("process handle does not match runtime mode")
		}
	case ResourceContainer:
		container := record.Handle.Container
		if container == nil || record.Handle.Process != nil || record.Mode != ModeDevcontainer || container.Provider == "" || container.ContainerID == "" || !sha256Pattern.MatchString(container.ImageDigest) || container.Binding != record.binding() {
			return fmt.Errorf("container handle is invalid")
		}
	default:
		return fmt.Errorf("runtime handle is required")
	}
	return nil
}

func validateDevServers(record runtimeRecord) error {
	if len(record.ExpectedDevServers) > 64 || len(record.DevServers) > len(record.ExpectedDevServers) || len(record.Shutdown) > 64 {
		return fmt.Errorf("dev-server resource counts are invalid")
	}
	expected := map[string]bool{}
	for _, name := range record.ExpectedDevServers {
		if !declarationNamePattern.MatchString(name) || expected[name] {
			return fmt.Errorf("expected dev-server identity is invalid")
		}
		expected[name] = true
	}
	for _, name := range record.Shutdown {
		if !declarationNamePattern.MatchString(name) {
			return fmt.Errorf("shutdown command identity is invalid")
		}
	}
	seen := map[string]bool{}
	for _, server := range record.DevServers {
		if !expected[server.Name] || seen[server.Name] || server.ServerID == "" || server.TmuxSession == "" || server.State == "" {
			return fmt.Errorf("managed dev-server evidence is invalid")
		}
		seen[server.Name] = true
	}
	return nil
}
