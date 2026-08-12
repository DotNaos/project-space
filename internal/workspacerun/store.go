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

	"golang.org/x/sys/unix"
)

const maximumStateBytes = 256 << 10

type runtimeRecord struct {
	Version            int                 `json:"schemaVersion"`
	WorkspaceID        string              `json:"workspaceId"`
	Repository         string              `json:"repository"`
	Directory          string              `json:"directory"`
	GitDirectory       string              `json:"gitDirectory"`
	Branch             string              `json:"branch"`
	Head               string              `json:"head"`
	IdentityProof      string              `json:"identityProof"`
	ManifestDigest     string              `json:"manifestDigest"`
	Mode               Mode                `json:"mode"`
	State              RuntimeState        `json:"state"`
	Generation         string              `json:"generation"`
	GenerationProof    string              `json:"generationProof"`
	GenerationRemoved  bool                `json:"generationRemoved"`
	GenerationArchive  string              `json:"generationArchive,omitempty"`
	OwnershipToken     string              `json:"ownershipToken"`
	Handle             RuntimeHandle       `json:"handle"`
	Resources          ResourceLimits      `json:"resources"`
	DevServers         []ManagedDevServer  `json:"devServers"`
	DevServerOperation *devServerOperation `json:"devServerOperation,omitempty"`
	ExpectedDevServers []string            `json:"expectedDevServers"`
	Shutdown           []string            `json:"shutdown"`
	StartedAt          string              `json:"startedAt,omitempty"`
	CheckedAt          string              `json:"checkedAt"`
	LastError          string              `json:"lastError,omitempty"`
}

func (record runtimeRecord) binding() RuntimeBinding {
	return RuntimeBinding{
		WorkspaceID: record.WorkspaceID, Generation: record.Generation,
		ManifestDigest: record.ManifestDigest, OwnershipToken: record.OwnershipToken,
	}
}

type stateStore struct {
	root                       string
	mu                         sync.Mutex
	directoryProofs            map[string]os.FileInfo
	stateProofs                map[string]os.FileInfo
	beforeGenerationQuarantine func() error
	afterGenerationQuarantine  func() error
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
		filepath.Join(resolved, "generations"),
	} {
		if err := ensurePrivateDirectory(directory); err != nil {
			return nil, err
		}
	}
	store := &stateStore{
		root: resolved, directoryProofs: map[string]os.FileInfo{},
		stateProofs: map[string]os.FileInfo{},
	}
	for _, name := range []string{"", "states", "locks", "generations"} {
		path := resolved
		if name != "" {
			path = filepath.Join(resolved, name)
		}
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
			return nil, fmt.Errorf("workspace runtime directory %q has no stable private identity", path)
		}
		store.directoryProofs[name] = info
	}
	return store, nil
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
	directory, err := store.openDirectory("states")
	if err != nil {
		return runtimeRecord{}, false, err
	}
	defer directory.Close()
	name := identity.WorkspaceID + ".json"
	fd, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, syscall.ENOENT) {
		return runtimeRecord{}, false, nil
	}
	if err != nil {
		return runtimeRecord{}, false, fmt.Errorf("open workspace runtime state: %w", err)
	}
	file := os.NewFile(uintptr(fd), store.statePath(identity.WorkspaceID))
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maximumStateBytes || info.Mode().Perm()&0o077 != 0 {
		return runtimeRecord{}, false, fmt.Errorf("workspace runtime state must be a private bounded regular file")
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
	store.stateProofs[identity.WorkspaceID] = info
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
	directory, err := store.openDirectory("states")
	if err != nil {
		return err
	}
	defer directory.Close()
	temporaryName := ".runtime-" + recordSafeNonce() + ".json"
	fd, err := unix.Openat(int(directory.Fd()), temporaryName, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return fmt.Errorf("create workspace runtime state: %w", err)
	}
	temporary := os.NewFile(uintptr(fd), filepath.Join(store.root, "states", temporaryName))
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
	name := record.WorkspaceID + ".json"
	if err := store.publishState(directory, name, temporaryName, record.WorkspaceID); err != nil {
		return err
	}
	proof, err := store.regularFileProof(directory, name)
	if err != nil {
		return err
	}
	store.stateProofs[record.WorkspaceID] = proof
	return directory.Sync()
}

func (store *stateStore) removeGeneration(workspaceID, generation, expectedProof string) (string, error) {
	if !workspaceIDPattern.MatchString(workspaceID) || !uuidPattern.MatchString(generation) || !filesystemIdentityPattern.MatchString(expectedProof) {
		return "", fmt.Errorf("runtime generation identity is invalid")
	}
	root, err := store.openDirectory("generations")
	if err != nil {
		return "", err
	}
	defer root.Close()
	parentFD, err := unix.Openat(int(root.Fd()), workspaceID, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, syscall.ENOENT) {
		return "", fmt.Errorf("runtime generation parent is missing before proof-bound cleanup")
	}
	if err != nil {
		return "", fmt.Errorf("runtime Workspace generation parent is not an owned directory")
	}
	parentFile := os.NewFile(uintptr(parentFD), filepath.Join(store.root, "generations", workspaceID))
	defer parentFile.Close()
	fd, err := unix.Openat(parentFD, generation, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, syscall.ENOENT) {
		found, scanErr := directoryContainsProof(parentFile, expectedProof, "")
		if scanErr != nil {
			return "", scanErr
		}
		if found != "" {
			return "", fmt.Errorf("proof-bound runtime generation moved before cleanup")
		}
		quarantineName, scanErr := directoryContainsProof(root, expectedProof, ".retained-"+generation+"-")
		if scanErr != nil {
			return "", scanErr
		}
		if quarantineName != "" {
			if err := finalizeGenerationRetention(parentFD, generation, parentFile, root); err != nil {
				return "", err
			}
			return quarantineName, nil
		}
		return "", fmt.Errorf("proof-bound runtime generation is absent from active and retained namespaces")
	}
	if err != nil {
		return "", fmt.Errorf("open runtime generation directory: %w", err)
	}
	opened := os.NewFile(uintptr(fd), generation)
	defer opened.Close()
	info, statErr := opened.Stat()
	if statErr != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 || fileIdentity(info) != expectedProof {
		return "", fmt.Errorf("runtime generation path is not an owned private directory")
	}
	quarantineName := ".retained-" + generation + "-" + recordSafeNonce()
	if store.beforeGenerationQuarantine != nil {
		if err := store.beforeGenerationQuarantine(); err != nil {
			return "", err
		}
	}
	if err := unix.Renameat(parentFD, generation, int(root.Fd()), quarantineName); err != nil {
		return "", fmt.Errorf("retain runtime generation directory: %w", err)
	}
	retainedFD, err := unix.Openat(int(root.Fd()), quarantineName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("reopen retained runtime generation: %w", err)
	}
	retained := os.NewFile(uintptr(retainedFD), quarantineName)
	retainedInfo, retainedErr := retained.Stat()
	_ = retained.Close()
	if retainedErr != nil || !os.SameFile(info, retainedInfo) || fileIdentity(retainedInfo) != expectedProof {
		return "", errors.Join(retainedErr, fmt.Errorf("runtime generation identity changed during retention"))
	}
	if err := finalizeGenerationRetention(parentFD, generation, parentFile, root); err != nil {
		return "", err
	}
	if store.afterGenerationQuarantine != nil {
		if err := store.afterGenerationQuarantine(); err != nil {
			return "", err
		}
	}
	return quarantineName, nil
}

func finalizeGenerationRetention(parentFD int, generation string, parentFile, root *os.File) error {
	var active unix.Stat_t
	if err := unix.Fstatat(parentFD, generation, &active, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, syscall.ENOENT) {
		if err == nil {
			err = fmt.Errorf("another directory appeared at the active generation name")
		}
		return fmt.Errorf("active generation namespace changed during retention: %w", err)
	}
	if err := parentFile.Sync(); err != nil {
		return fmt.Errorf("sync active generation namespace after retention: %w", err)
	}
	if err := root.Sync(); err != nil {
		return fmt.Errorf("sync retained generation namespace: %w", err)
	}
	return nil
}

func (store *stateStore) prepareGeneration(workspaceID, generation string) (string, error) {
	if !workspaceIDPattern.MatchString(workspaceID) || !uuidPattern.MatchString(generation) {
		return "", fmt.Errorf("runtime generation identity is invalid")
	}
	root, err := store.openDirectory("generations")
	if err != nil {
		return "", err
	}
	defer root.Close()
	if err := mkdirPrivateAt(int(root.Fd()), workspaceID); err != nil {
		return "", err
	}
	parentFD, err := unix.Openat(int(root.Fd()), workspaceID, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("open runtime generation parent: %w", err)
	}
	defer unix.Close(parentFD)
	if err := unix.Mkdirat(parentFD, generation, 0o700); err != nil {
		return "", fmt.Errorf("create private runtime generation: %w", err)
	}
	fd, err := unix.Openat(parentFD, generation, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("open private runtime generation: %w", err)
	}
	file := os.NewFile(uintptr(fd), generation)
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("runtime generation is not a private directory")
	}
	return fileIdentity(info), nil
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
	lockPath := filepath.Join(store.root, "locks", workspaceID+".lock")
	directory, err := store.openDirectory("locks")
	if err != nil {
		return err
	}
	defer directory.Close()
	fd, err := unix.Openat(int(directory.Fd()), filepath.Base(lockPath), unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return fmt.Errorf("open workspace runtime lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), lockPath)
	defer file.Close()
	info, statErr := file.Stat()
	if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("workspace runtime lock must be a private regular file")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("acquire workspace runtime lock: %w", err)
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return action()
}

func recordSafeNonce() string {
	value, err := randomToken()
	if err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return strings.ReplaceAll(value, "-", "")
}

func (store *stateStore) statePath(workspaceID string) string {
	return filepath.Join(store.root, "states", workspaceID+".json")
}
func (store *stateStore) logPath(workspaceID, generation string) string {
	return filepath.Join(store.root, "generations", workspaceID, generation, "runtime.log")
}

func validateRecord(record runtimeRecord, identity WorkspaceIdentity) error {
	if record.Version != SchemaVersion {
		return fmt.Errorf("schemaVersion must be %d", SchemaVersion)
	}
	if !workspaceIDPattern.MatchString(record.WorkspaceID) || !uuidPattern.MatchString(record.Generation) || !filesystemIdentityPattern.MatchString(record.GenerationProof) || !tokenPattern.MatchString(record.OwnershipToken) || !sha256Pattern.MatchString(record.ManifestDigest) || !sha256Pattern.MatchString(record.IdentityProof) {
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
	archivePrefix := ".retained-" + record.Generation + "-"
	archiveValid := strings.HasPrefix(record.GenerationArchive, archivePrefix) && len(record.GenerationArchive) <= 128 && !strings.ContainsAny(record.GenerationArchive, "/\\\x00")
	if record.GenerationRemoved && (!archiveValid || record.State != StateStopped && record.State != StateFailed || record.Handle.Kind != "" || len(record.DevServers) != 0 || record.DevServerOperation != nil) {
		return fmt.Errorf("removed generation must be terminal and retain no resource evidence")
	}
	if !record.GenerationRemoved && record.GenerationArchive != "" {
		return fmt.Errorf("active generation cannot have a retained archive")
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
		if record.Handle.Process == nil || record.Handle.Container != nil || record.Handle.Process.PID <= 0 || !sha256Pattern.MatchString(record.Handle.Process.Identity) || record.Handle.Process.BindingDigest != bindingDigest(record.binding()) || !filepath.IsAbs(record.Handle.Process.AppServerSocket) || filepath.Clean(record.Handle.Process.AppServerSocket) != record.Handle.Process.AppServerSocket || len(record.Handle.Process.AppServerSocket) > 4096 {
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
	if operation := record.DevServerOperation; operation != nil {
		if !expected[operation.Name] || operation.Action != devServerStarting && operation.Action != devServerStopping {
			return fmt.Errorf("dev-server operation evidence is invalid")
		}
		if operation.Action == devServerStarting && seen[operation.Name] {
			return fmt.Errorf("dev-server start operation duplicates persisted evidence")
		}
		if operation.Action == devServerStopping && !seen[operation.Name] {
			return fmt.Errorf("dev-server stop operation has no persisted evidence")
		}
	}
	if (record.State == StateStopped || record.State == StateFailed || record.State == StateCleaning) && record.DevServerOperation != nil {
		return fmt.Errorf("terminal runtime state must not retain a dev-server operation")
	}
	return nil
}
