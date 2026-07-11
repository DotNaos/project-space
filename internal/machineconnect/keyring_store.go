package machineconnect

import (
	"context"
	"encoding/json"
	"errors"
)

const maximumKeyringCredentialBytes = 2 * 1024

type keyringBackend interface {
	Delete(service, account string) error
	Get(service, account string) (string, error)
	IsNotFound(error) bool
	Set(service, account, secret string) error
}

type keyringCredentialStore struct {
	account string
	backend keyringBackend
	lock    *FileStore
	service string
}

func newKeyringCredentialStore(
	backend keyringBackend,
	service string,
	account string,
	lockPath string,
) (*keyringCredentialStore, error) {
	if backend == nil || service == "" || account == "" {
		return nil, errors.New("secure credential store configuration is incomplete")
	}
	lockStore, err := NewFileStore(lockPath)
	if err != nil {
		return nil, err
	}
	return &keyringCredentialStore{
		account: account,
		backend: backend,
		lock:    lockStore,
		service: service,
	}, nil
}

func (store *keyringCredentialStore) Lock(ctx context.Context) (func() error, error) {
	return store.lock.Lock(ctx)
}

func (store *keyringCredentialStore) Load() (Credential, error) {
	state, err := store.loadState()
	if err != nil {
		return Credential{}, err
	}
	if state.Credential == nil {
		return Credential{}, ErrCredentialNotFound
	}
	return *state.Credential, nil
}

func (store *keyringCredentialStore) LoadKey() (MachineKey, error) {
	state, err := store.loadState()
	if errors.Is(err, ErrCredentialNotFound) {
		return MachineKey{}, ErrMachineKeyNotFound
	}
	if err != nil {
		return MachineKey{}, err
	}
	key, err := machineKeyFromString(state.PrivateKey)
	if err != nil {
		return MachineKey{}, errors.New("parse machine identity: invalid value")
	}
	return key, nil
}

func (store *keyringCredentialStore) SaveKey(key MachineKey) error {
	encoded, err := key.encoded()
	if err != nil {
		return errors.New("save machine identity: invalid value")
	}
	state, err := store.loadState()
	if errors.Is(err, ErrCredentialNotFound) {
		state = localMachineState{}
	} else if err != nil {
		return err
	}
	state.PrivateKey = encoded
	return store.writeState(state)
}

func (store *keyringCredentialStore) loadState() (localMachineState, error) {
	secret, err := store.backend.Get(store.service, store.account)
	if err != nil {
		if store.backend.IsNotFound(err) {
			return localMachineState{}, ErrCredentialNotFound
		}
		return localMachineState{}, errors.New("read machine credential from secure storage")
	}
	if len(secret) == 0 || len(secret) > maximumKeyringCredentialBytes {
		return localMachineState{}, errors.New("parse machine credential: invalid secure value")
	}
	var state localMachineState
	if err := json.Unmarshal([]byte(secret), &state); err != nil {
		return localMachineState{}, errors.New("parse machine credential: invalid JSON")
	}
	if err := state.validate(); err != nil {
		return localMachineState{}, errors.New("parse machine credential: invalid value")
	}
	return state, nil
}

func (store *keyringCredentialStore) Save(credential Credential) error {
	if err := validateCredential(credential); err != nil {
		return errors.New("save machine credential: invalid value")
	}
	state, err := store.loadState()
	if errors.Is(err, ErrCredentialNotFound) {
		return ErrMachineKeyNotFound
	}
	if err != nil {
		return err
	}
	state.Credential = &credential
	return store.writeState(state)
}

func (store *keyringCredentialStore) writeState(state localMachineState) error {
	if err := state.validate(); err != nil {
		return errors.New("save machine credential: invalid value")
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return errors.New("encode machine credential")
	}
	if len(encoded) > maximumKeyringCredentialBytes {
		return errors.New("save machine credential: secure value is too large")
	}
	if err := store.backend.Set(store.service, store.account, string(encoded)); err != nil {
		return errors.New("write machine credential to secure storage")
	}
	return nil
}

func (store *keyringCredentialStore) Delete() error {
	state, err := store.loadState()
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
