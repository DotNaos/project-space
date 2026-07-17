package machineconnect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

type FileStore struct {
	path string
}

const (
	maximumLocalMachineStateBytes        = 16 * 1024
	machineCredentialTemporaryFilePrefix = ".machine-credential-"
	CodexOperationSnapshotFilename       = "codex-operations.json"
)

var ErrFileCredentialStoreUnsupported = errors.New(
	"private file credential storage is not supported on this operating system",
)

func NewFileStore(path string) (*FileStore, error) {
	resolved, err := credentialPath(path)
	if err != nil {
		return nil, err
	}
	return &FileStore{path: resolved}, nil
}

func DefaultCredentialPath() (string, error) {
	return credentialPath("")
}

func DefaultCodexOperationSnapshotPath() (string, error) {
	credential, err := DefaultCredentialPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(credential), CodexOperationSnapshotFilename), nil
}

func (store *FileStore) Path() string {
	return store.path
}

func (store *FileStore) Lock(ctx context.Context) (func() error, error) {
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create machine credential directory: %w", err)
	}
	if err := rejectDirectorySymlink(directory); err != nil {
		return nil, err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, fmt.Errorf("secure machine credential directory: %w", err)
	}

	lockPath := store.path + ".lock"
	if err := rejectSymlink(lockPath); err != nil {
		return nil, fmt.Errorf("inspect machine credential lock: %w", err)
	}
	lock := flock.New(lockPath, flock.SetPermissions(0o600))
	locked, err := lock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("lock machine credential: %w", err)
	}
	if !locked {
		_ = lock.Close()
		return nil, errors.New("lock machine credential: lock was not acquired")
	}
	return lock.Close, nil
}

func (store *FileStore) Load() (Credential, error) {
	state, err := store.readState()
	if err != nil {
		return Credential{}, err
	}
	if state.Credential == nil {
		return Credential{}, ErrCredentialNotFound
	}
	return *state.Credential, nil
}

func (store *FileStore) LoadKey() (MachineKey, error) {
	state, err := store.readState()
	if errors.Is(err, ErrCredentialNotFound) {
		return MachineKey{}, ErrMachineKeyNotFound
	}
	if err != nil {
		return MachineKey{}, err
	}
	key, err := machineKeyFromString(state.PrivateKey)
	if err != nil {
		return MachineKey{}, fmt.Errorf("parse machine identity: %w", err)
	}
	return key, nil
}

func (store *FileStore) SaveKey(key MachineKey) error {
	encoded, err := key.encoded()
	if err != nil {
		return fmt.Errorf("save machine identity: %w", err)
	}
	state, err := store.readState()
	if errors.Is(err, ErrCredentialNotFound) {
		state = localMachineState{}
	} else if err != nil {
		return err
	}
	state.PrivateKey = encoded
	return store.writeState(state)
}

func (store *FileStore) readState() (localMachineState, error) {
	if !privateFileCredentialStorageSupported {
		return localMachineState{}, ErrFileCredentialStoreUnsupported
	}
	info, err := os.Lstat(store.path)
	if errors.Is(err, fs.ErrNotExist) {
		return localMachineState{}, ErrCredentialNotFound
	}
	if err != nil {
		return localMachineState{}, fmt.Errorf("inspect machine credential: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return localMachineState{}, errors.New("machine credential path is not a regular file")
	}
	if info.Size() > maximumLocalMachineStateBytes {
		return localMachineState{}, errors.New("parse machine credential: state file is too large")
	}
	if err := os.Chmod(store.path, 0o600); err != nil {
		return localMachineState{}, fmt.Errorf("secure machine credential: %w", err)
	}
	file, err := os.Open(store.path)
	if err != nil {
		return localMachineState{}, fmt.Errorf("read machine credential: %w", err)
	}
	body, readErr := io.ReadAll(io.LimitReader(file, maximumLocalMachineStateBytes+1))
	closeErr := file.Close()
	if readErr != nil {
		return localMachineState{}, fmt.Errorf("read machine credential: %w", readErr)
	}
	if closeErr != nil {
		return localMachineState{}, fmt.Errorf("close machine credential: %w", closeErr)
	}
	if len(body) > maximumLocalMachineStateBytes {
		return localMachineState{}, errors.New("parse machine credential: state file is too large")
	}
	var state localMachineState
	if err := json.Unmarshal(body, &state); err != nil {
		return localMachineState{}, errors.New("parse machine credential: invalid JSON")
	}
	if err := state.validate(); err != nil {
		return localMachineState{}, fmt.Errorf("parse machine credential: %w", err)
	}
	return state, nil
}

func (store *FileStore) Save(credential Credential) error {
	if err := validateCredential(credential); err != nil {
		return fmt.Errorf("save machine credential: %w", err)
	}
	state, err := store.readState()
	if errors.Is(err, ErrCredentialNotFound) {
		return ErrMachineKeyNotFound
	}
	if err != nil {
		return err
	}
	state.Credential = &credential
	return store.writeState(state)
}

func (store *FileStore) writeState(state localMachineState) error {
	if !privateFileCredentialStorageSupported {
		return ErrFileCredentialStoreUnsupported
	}
	if err := state.validate(); err != nil {
		return fmt.Errorf("save machine credential: %w", err)
	}
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create machine credential directory: %w", err)
	}
	if err := rejectDirectorySymlink(directory); err != nil {
		return err
	}
	if err := rejectSymlink(store.path); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("secure machine credential directory: %w", err)
	}

	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return errors.New("encode machine credential")
	}
	body = append(body, '\n')
	if len(body) > maximumLocalMachineStateBytes {
		return errors.New("save machine credential: state file is too large")
	}
	temporary, err := os.CreateTemp(directory, machineCredentialTemporaryFilePrefix)
	if err != nil {
		return fmt.Errorf("create temporary machine credential: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure temporary machine credential: %w", err)
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write temporary machine credential: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync temporary machine credential: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary machine credential: %w", err)
	}
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return fmt.Errorf("install machine credential: %w", err)
	}
	if err := os.Chmod(store.path, 0o600); err != nil {
		return fmt.Errorf("secure machine credential: %w", err)
	}
	return nil
}

func (store *FileStore) Delete() error {
	state, err := store.readState()
	if errors.Is(err, ErrCredentialNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if state.Credential == nil {
		return nil
	}
	state.Credential = nil
	return store.writeState(state)
}

func (store *FileStore) Purge() error {
	directory := filepath.Dir(store.path)
	if err := rejectDirectorySymlink(directory); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := rejectSymlink(store.path); err != nil {
		return err
	}
	if err := purgeCredentialTemporaryFiles(directory); err != nil {
		return err
	}
	if err := os.Remove(store.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove machine identity: %w", err)
	}
	return nil
}

func purgeCredentialTemporaryFiles(directory string) error {
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect temporary machine identities: %w", err)
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), machineCredentialTemporaryFilePrefix) {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return fmt.Errorf("inspect temporary machine identity: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return errors.New("temporary machine identity path is not a regular file")
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove temporary machine identity: %w", err)
		}
	}
	return nil
}

func credentialPath(explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		resolved, err := filepath.Abs(explicit)
		if err != nil {
			return "", fmt.Errorf("resolve machine credential path: %w", err)
		}
		return resolved, nil
	}
	configDirectory, err := defaultCredentialDirectory()
	if err != nil {
		return "", fmt.Errorf("resolve machine credential directory: %w", err)
	}
	return filepath.Join(configDirectory, "project-space", "machine-credential.json"), nil
}

func rejectSymlink(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect machine credential: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("machine credential path is not a regular file")
	}
	return nil
}

func validateCredential(credential Credential) error {
	if len(credential.BackendURL) > 4096 || strings.TrimSpace(credential.BackendURL) != credential.BackendURL {
		return errors.New("backend URL is invalid")
	}
	backendURL, err := url.Parse(credential.BackendURL)
	if err != nil || backendURL.Host == "" || backendURL.User != nil ||
		(backendURL.Scheme != "https" && backendURL.Scheme != "http") {
		return errors.New("backend URL is missing")
	}
	if backendURL.Scheme != "https" && backendURL.Hostname() != "127.0.0.1" && backendURL.Hostname() != "localhost" {
		return errors.New("backend URL must use HTTPS")
	}
	if backendURL.RawQuery != "" || backendURL.Fragment != "" {
		return errors.New("backend URL is invalid")
	}
	if !validIdentifier(credential.MachineID) {
		return errors.New("machine ID is invalid")
	}
	if strings.TrimSpace(credential.MachineName) == "" ||
		strings.TrimSpace(credential.MachineName) != credential.MachineName ||
		len(credential.MachineName) > 256 || containsControlCharacter(credential.MachineName) {
		return errors.New("machine name is invalid")
	}
	if !validOpaqueValue(credential.Token) {
		return errors.New("machine authorization credential is invalid")
	}
	if credential.IssuedAt.IsZero() {
		return errors.New("machine credential issue time is invalid")
	}
	return nil
}

func containsControlCharacter(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

func rejectDirectorySymlink(directory string) error {
	info, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("inspect machine credential directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("machine credential directory is not a regular directory")
	}
	return nil
}
