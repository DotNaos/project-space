package machineconnect

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"io"
)

type MachineKey struct {
	privateKey ed25519.PrivateKey
}

func GenerateMachineKey(random io.Reader) (MachineKey, error) {
	if random == nil {
		return MachineKey{}, errors.New("machine key randomness is unavailable")
	}
	_, privateKey, err := ed25519.GenerateKey(random)
	if err != nil {
		return MachineKey{}, errors.New("generate machine identity key")
	}
	return MachineKey{privateKey: privateKey}, nil
}

func machineKeyFromString(encoded string) (MachineKey, error) {
	privateKey, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(privateKey) != ed25519.PrivateKeySize {
		return MachineKey{}, errors.New("machine private key is invalid")
	}
	return MachineKey{privateKey: ed25519.PrivateKey(privateKey)}, nil
}

func (key MachineKey) encoded() (string, error) {
	if len(key.privateKey) != ed25519.PrivateKeySize {
		return "", errors.New("machine private key is invalid")
	}
	return base64.RawURLEncoding.EncodeToString(key.privateKey), nil
}

func (key MachineKey) PublicKey() (string, error) {
	if len(key.privateKey) != ed25519.PrivateKeySize {
		return "", errors.New("machine private key is invalid")
	}
	publicKey := key.privateKey.Public().(ed25519.PublicKey)
	return base64.RawURLEncoding.EncodeToString(publicKey), nil
}

func (key MachineKey) Sign(message []byte) ([]byte, error) {
	if len(key.privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("machine private key is invalid")
	}
	return ed25519.Sign(key.privateKey, message), nil
}

func (MachineKey) String() string {
	return "[redacted machine key]"
}

func (MachineKey) GoString() string {
	return "machineconnect.MachineKey{[redacted]}"
}

type localMachineState struct {
	Credential *Credential `json:"credential,omitempty"`
	PrivateKey string      `json:"privateKey"`
}

func (state localMachineState) validate() error {
	if _, err := machineKeyFromString(state.PrivateKey); err != nil {
		return err
	}
	if state.Credential != nil {
		return validateCredential(*state.Credential)
	}
	return nil
}
