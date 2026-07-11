//go:build windows

package machineconnect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

const (
	windowsDPAPIStateVersion          = "project-space.machine-credential.dpapi/v1"
	maximumWindowsDPAPIEncryptedBytes = 64 * 1024
	maximumWindowsDPAPIEnvelopeBytes  = 96 * 1024
)

type windowsDPAPIEnvelope struct {
	Version    string `json:"version"`
	Ciphertext []byte `json:"ciphertext"`
}

type windowsDPAPICredentialStore struct {
	lock *FileStore
	path string
}

func newWindowsDPAPICredentialStore(path string) (*windowsDPAPICredentialStore, error) {
	lockStore, err := NewFileStore(path)
	if err != nil {
		return nil, err
	}
	return &windowsDPAPICredentialStore{
		lock: lockStore,
		path: lockStore.Path(),
	}, nil
}

func (store *windowsDPAPICredentialStore) Lock(ctx context.Context) (func() error, error) {
	if err := ensureWindowsCredentialDirectory(filepath.Dir(store.path)); err != nil {
		return nil, err
	}
	if err := rejectWindowsReparsePointIfPresent(store.path + ".lock"); err != nil {
		return nil, err
	}
	return store.lock.Lock(ctx)
}

func (store *windowsDPAPICredentialStore) Load() (Credential, error) {
	state, err := store.readState()
	if err != nil {
		return Credential{}, err
	}
	if state.Credential == nil {
		return Credential{}, ErrCredentialNotFound
	}
	return *state.Credential, nil
}

func (store *windowsDPAPICredentialStore) LoadKey() (MachineKey, error) {
	state, err := store.readState()
	if errors.Is(err, ErrCredentialNotFound) {
		return MachineKey{}, ErrMachineKeyNotFound
	}
	if err != nil {
		return MachineKey{}, err
	}
	key, err := machineKeyFromString(state.PrivateKey)
	if err != nil {
		return MachineKey{}, errors.New("parse machine identity: invalid protected value")
	}
	return key, nil
}

func (store *windowsDPAPICredentialStore) SaveKey(key MachineKey) error {
	encoded, err := key.encoded()
	if err != nil {
		return errors.New("save machine identity: invalid value")
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

func (store *windowsDPAPICredentialStore) Save(credential Credential) error {
	if err := validateCredential(credential); err != nil {
		return errors.New("save machine credential: invalid value")
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

func (store *windowsDPAPICredentialStore) Delete() error {
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

func (store *windowsDPAPICredentialStore) Purge() error {
	directory := filepath.Dir(store.path)
	if err := inspectWindowsCredentialDirectoryIfPresent(directory); err != nil {
		return err
	}
	if err := rejectWindowsReparsePointIfPresent(store.path); err != nil {
		return err
	}
	if err := purgeWindowsCredentialTemporaryFiles(directory); err != nil {
		return err
	}
	if err := os.Remove(store.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("remove machine identity")
	}
	return nil
}

func (store *windowsDPAPICredentialStore) readState() (localMachineState, error) {
	body, err := readWindowsCredentialEnvelope(store.path)
	if err != nil {
		return localMachineState{}, err
	}
	var envelope windowsDPAPIEnvelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return localMachineState{}, errors.New("parse machine credential: invalid protected envelope")
	}
	if err := requireJSONEOF(decoder); err != nil {
		return localMachineState{}, err
	}
	if envelope.Version != windowsDPAPIStateVersion || len(envelope.Ciphertext) == 0 ||
		len(envelope.Ciphertext) > maximumWindowsDPAPIEncryptedBytes {
		return localMachineState{}, errors.New("parse machine credential: invalid protected envelope")
	}
	plaintext, err := unprotectWindowsDPAPI(envelope.Ciphertext)
	if err != nil {
		return localMachineState{}, err
	}
	defer clear(plaintext)
	var state localMachineState
	stateDecoder := json.NewDecoder(bytes.NewReader(plaintext))
	stateDecoder.DisallowUnknownFields()
	if err := stateDecoder.Decode(&state); err != nil {
		return localMachineState{}, errors.New("parse machine credential: invalid protected state")
	}
	if err := requireJSONEOF(stateDecoder); err != nil {
		return localMachineState{}, errors.New("parse machine credential: invalid protected state")
	}
	if err := state.validate(); err != nil {
		return localMachineState{}, errors.New("parse machine credential: invalid protected state")
	}
	return state, nil
}

func (store *windowsDPAPICredentialStore) writeState(state localMachineState) error {
	if err := state.validate(); err != nil {
		return errors.New("save machine credential: invalid value")
	}
	plaintext, err := json.Marshal(state)
	if err != nil {
		return errors.New("encode machine credential")
	}
	defer clear(plaintext)
	if len(plaintext) == 0 || len(plaintext) > maximumLocalMachineStateBytes {
		return errors.New("save machine credential: state is too large")
	}
	ciphertext, err := protectWindowsDPAPI(plaintext)
	if err != nil {
		return err
	}
	envelope, err := json.Marshal(windowsDPAPIEnvelope{
		Version:    windowsDPAPIStateVersion,
		Ciphertext: ciphertext,
	})
	if err != nil {
		return errors.New("encode protected machine credential")
	}
	if len(envelope) == 0 || len(envelope) > maximumWindowsDPAPIEnvelopeBytes {
		return errors.New("save machine credential: protected state is too large")
	}
	return writeWindowsCredentialEnvelope(store.path, envelope)
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("parse machine credential: expected one protected value")
	}
	return nil
}

func readWindowsCredentialEnvelope(path string) ([]byte, error) {
	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, errors.New("read machine credential: invalid path")
	}
	handle, err := windows.CreateFile(
		pathPointer,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return nil, ErrCredentialNotFound
	}
	if err != nil {
		return nil, errors.New("read machine credential: open protected state")
	}
	var information windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &information); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("read machine credential: inspect protected state")
	}
	if information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 ||
		information.FileSizeHigh != 0 ||
		information.FileSizeLow == 0 ||
		information.FileSizeLow > maximumWindowsDPAPIEnvelopeBytes {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("read machine credential: protected state is not a bounded regular file")
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("read machine credential: open protected state")
	}
	body, readErr := io.ReadAll(io.LimitReader(file, maximumWindowsDPAPIEnvelopeBytes+1))
	closeErr := file.Close()
	if readErr != nil {
		return nil, errors.New("read machine credential: protected state")
	}
	if closeErr != nil {
		return nil, errors.New("read machine credential: close protected state")
	}
	if len(body) == 0 || len(body) > maximumWindowsDPAPIEnvelopeBytes {
		return nil, errors.New("read machine credential: protected state is too large")
	}
	return body, nil
}

func writeWindowsCredentialEnvelope(path string, body []byte) error {
	if len(body) == 0 || len(body) > maximumWindowsDPAPIEnvelopeBytes {
		return errors.New("write machine credential: invalid protected state")
	}
	directory := filepath.Dir(path)
	if err := ensureWindowsCredentialDirectory(directory); err != nil {
		return err
	}
	if err := rejectWindowsReparsePointIfPresent(path); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, machineCredentialTemporaryFilePrefix)
	if err != nil {
		return errors.New("write machine credential: create temporary protected state")
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return errors.New("write machine credential: temporary protected state")
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return errors.New("write machine credential: sync temporary protected state")
	}
	if err := temporary.Close(); err != nil {
		return errors.New("write machine credential: close temporary protected state")
	}
	if err := rejectWindowsReparsePointIfPresent(temporaryPath); err != nil {
		return err
	}
	from, err := windows.UTF16PtrFromString(temporaryPath)
	if err != nil {
		return errors.New("write machine credential: invalid temporary path")
	}
	to, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return errors.New("write machine credential: invalid destination path")
	}
	if err := windows.MoveFileEx(
		from,
		to,
		windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH,
	); err != nil {
		return errors.New("write machine credential: install protected state")
	}
	return nil
}

func inspectWindowsCredentialDirectoryIfPresent(directory string) error {
	pointer, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return errors.New("inspect machine credential directory")
	}
	attributes, err := windows.GetFileAttributes(pointer)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return nil
	}
	if err != nil || attributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 ||
		attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("machine credential directory is not a regular directory")
	}
	return nil
}

func purgeWindowsCredentialTemporaryFiles(directory string) error {
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("inspect temporary machine identities")
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), machineCredentialTemporaryFilePrefix) {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		if err := rejectWindowsReparsePointIfPresent(path); err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("temporary machine identity path is not a regular file")
		}
		if err := os.Remove(path); err != nil {
			return errors.New("remove temporary machine identity")
		}
	}
	return nil
}

func ensureWindowsCredentialDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return errors.New("create machine credential directory")
	}
	pointer, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return errors.New("inspect machine credential directory")
	}
	attributes, err := windows.GetFileAttributes(pointer)
	if err != nil || attributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 ||
		attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("machine credential directory is not a regular directory")
	}
	return nil
}

func rejectWindowsReparsePointIfPresent(path string) error {
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return errors.New("inspect machine credential path")
	}
	attributes, err := windows.GetFileAttributes(pointer)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return nil
	}
	if err != nil {
		return errors.New("inspect machine credential path")
	}
	if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		attributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		return errors.New("machine credential path is not a regular file")
	}
	return nil
}
