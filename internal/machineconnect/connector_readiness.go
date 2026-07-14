package machineconnect

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	ConnectorRuntimeReadyFileEnv         = "PROJECT_CONNECTOR_READY_FILE"
	ConnectorRuntimeReadyAttemptNonceEnv = "PROJECT_CONNECTOR_READY_ATTEMPT_NONCE"
	connectorRuntimeReadySchema          = "project-space.connector-runtime-ready/v2"
	connectorRuntimeReadyAttemptSchema   = "project-space.connector-runtime-ready-attempt/v1"
	connectorRuntimeReadyName            = "connector-ready.json"
	connectorRuntimeReadyAttemptName     = "connector-ready-attempt.json"
	maximumConnectorReadyBytes           = 4 * 1024
	connectorReadyNonceBytes             = 32
	connectorReadyPollInterval           = 25 * time.Millisecond
)

// ConnectorRuntimeReadinessIdentity is the immutable identity a service start
// must observe after the connector has authenticated with Project Space.
type ConnectorRuntimeReadinessIdentity struct {
	MachineID    string
	BuildID      string
	ReleaseID    string
	AttemptNonce string
}

type connectorRuntimeReadinessDocument struct {
	Schema       string `json:"schema"`
	MachineID    string `json:"machineId"`
	BuildID      string `json:"buildId"`
	ReleaseID    string `json:"releaseId"`
	AttemptNonce string `json:"attemptNonce"`
}

type connectorRuntimeReadinessAttemptDocument struct {
	Schema       string `json:"schema"`
	AttemptNonce string `json:"attemptNonce"`
}

// DefaultConnectorRuntimeReadinessPath returns the fixed private local path
// shared by the Project CLI supervisor and its companion connector.
func DefaultConnectorRuntimeReadinessPath() (string, error) {
	credentialPath, err := DefaultCredentialPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(credentialPath), connectorRuntimeReadyName), nil
}

// BeginConnectorRuntimeReadinessAttempt clears previous evidence and publishes
// a private one-time challenge for the next connector supervisor process.
func BeginConnectorRuntimeReadinessAttempt(path string) (string, error) {
	if err := ClearConnectorRuntimeReadiness(path); err != nil {
		return "", err
	}
	if err := ClearConnectorRuntimeReadinessAttempt(path); err != nil {
		return "", err
	}
	nonce, err := newConnectorRuntimeReadinessNonce()
	if err != nil {
		return "", fmt.Errorf("generate connector readiness attempt: %w", err)
	}
	document := connectorRuntimeReadinessAttemptDocument{
		Schema:       connectorRuntimeReadyAttemptSchema,
		AttemptNonce: nonce,
	}
	if err := writeConnectorRuntimeReadinessDocument(
		connectorRuntimeReadinessAttemptPath(path),
		document,
	); err != nil {
		return "", fmt.Errorf("publish connector readiness attempt: %w", err)
	}
	return nonce, nil
}

// ConsumeConnectorRuntimeReadinessAttempt claims the current start challenge
// exactly once. Long-running supervisors never reread this file.
func ConsumeConnectorRuntimeReadinessAttempt(path string) (string, bool, error) {
	if err := prepareConnectorRuntimeReadinessPath(path); err != nil {
		return "", false, err
	}
	attemptPath := connectorRuntimeReadinessAttemptPath(path)
	info, err := os.Lstat(attemptPath)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("inspect connector readiness attempt: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return "", false, errors.New("connector readiness attempt is unsafe")
	}
	claimNonce, err := newConnectorRuntimeReadinessNonce()
	if err != nil {
		return "", false, fmt.Errorf("claim connector readiness attempt: %w", err)
	}
	claimedPath := filepath.Join(
		filepath.Dir(path),
		".connector-ready-attempt-"+claimNonce+".claimed",
	)
	if err := os.Rename(attemptPath, claimedPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("claim connector readiness attempt: %w", err)
	}
	defer os.Remove(claimedPath) // best-effort cleanup of the already-consumed challenge
	body, err := readPrivateConnectorRuntimeReadinessFile(claimedPath, "attempt")
	if err != nil {
		return "", false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var document connectorRuntimeReadinessAttemptDocument
	if err := decoder.Decode(&document); err != nil {
		return "", false, errors.New("connector readiness attempt is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) ||
		document.Schema != connectorRuntimeReadyAttemptSchema ||
		!validConnectorRuntimeReadinessNonce(document.AttemptNonce) {
		return "", false, errors.New("connector readiness attempt is invalid")
	}
	return document.AttemptNonce, true, nil
}

// ClearConnectorRuntimeReadinessAttempt removes an unconsumed start challenge.
func ClearConnectorRuntimeReadinessAttempt(path string) error {
	if err := prepareConnectorRuntimeReadinessPath(path); err != nil {
		return err
	}
	attemptPath := connectorRuntimeReadinessAttemptPath(path)
	info, err := os.Lstat(attemptPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect connector readiness attempt: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("connector readiness attempt is unsafe")
	}
	if err := os.Remove(attemptPath); err != nil {
		return fmt.Errorf("clear connector readiness attempt: %w", err)
	}
	return nil
}

// ClearConnectorRuntimeReadiness removes stale reconnect evidence before a
// service start. Unsafe path types fail closed rather than being followed.
func ClearConnectorRuntimeReadiness(path string) error {
	if err := prepareConnectorRuntimeReadinessPath(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect connector readiness proof: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("connector readiness proof path is unsafe")
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("clear connector readiness proof: %w", err)
	}
	return nil
}

// WaitForConnectorRuntimeReadiness waits until the authenticated companion has
// atomically published evidence for the exact machine, build, and start attempt.
func WaitForConnectorRuntimeReadiness(
	ctx context.Context,
	path string,
	expected ConnectorRuntimeReadinessIdentity,
) error {
	if ctx == nil {
		return errors.New("connector readiness context is missing")
	}
	if err := validateConnectorRuntimeReadinessIdentity(expected); err != nil {
		return err
	}
	if err := prepareConnectorRuntimeReadinessPath(path); err != nil {
		return err
	}

	ticker := time.NewTicker(connectorReadyPollInterval)
	defer ticker.Stop()
	for {
		actual, found, err := readConnectorRuntimeReadiness(path)
		if err != nil {
			return err
		}
		if found && actual == expected {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for authenticated connector readiness: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func prepareConnectorRuntimeReadinessPath(path string) error {
	if !filepath.IsAbs(path) || filepath.Base(path) != connectorRuntimeReadyName {
		return errors.New("connector readiness proof path is invalid")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create connector readiness directory: %w", err)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("inspect connector readiness directory: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("connector readiness directory is unsafe")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("secure connector readiness directory: %w", err)
	}
	return nil
}

func validateConnectorRuntimeReadinessIdentity(identity ConnectorRuntimeReadinessIdentity) error {
	if !validIdentifier(identity.MachineID) {
		return errors.New("connector readiness machine identity is invalid")
	}
	build := ConnectorSupervisorBuildIdentity{
		BuildID: identity.BuildID, ReleaseID: identity.ReleaseID,
	}
	if build == (ConnectorSupervisorBuildIdentity{}) ||
		validateConnectorSupervisorBuildIdentity(build) != nil {
		return errors.New("connector readiness build identity is invalid")
	}
	if !validConnectorRuntimeReadinessNonce(identity.AttemptNonce) {
		return errors.New("connector readiness attempt is invalid")
	}
	return nil
}

func readConnectorRuntimeReadiness(
	path string,
) (ConnectorRuntimeReadinessIdentity, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return ConnectorRuntimeReadinessIdentity{}, false, nil
	}
	if err != nil {
		return ConnectorRuntimeReadinessIdentity{}, false,
			fmt.Errorf("inspect connector readiness proof: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return ConnectorRuntimeReadinessIdentity{}, false,
			errors.New("connector readiness proof path is unsafe")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return ConnectorRuntimeReadinessIdentity{}, false,
			errors.New("connector readiness proof is not private")
	}
	body, err := readPrivateConnectorRuntimeReadinessFile(path, "proof")
	if err != nil {
		return ConnectorRuntimeReadinessIdentity{}, false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var document connectorRuntimeReadinessDocument
	if err := decoder.Decode(&document); err != nil {
		return ConnectorRuntimeReadinessIdentity{}, false, nil
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ConnectorRuntimeReadinessIdentity{}, false, nil
	}
	identity := ConnectorRuntimeReadinessIdentity{
		MachineID:    document.MachineID,
		BuildID:      document.BuildID,
		ReleaseID:    document.ReleaseID,
		AttemptNonce: document.AttemptNonce,
	}
	if document.Schema != connectorRuntimeReadySchema ||
		validateConnectorRuntimeReadinessIdentity(identity) != nil {
		return ConnectorRuntimeReadinessIdentity{}, false, nil
	}
	return identity, true, nil
}

func connectorRuntimeReadinessAttemptPath(path string) string {
	return filepath.Join(filepath.Dir(path), connectorRuntimeReadyAttemptName)
}

func newConnectorRuntimeReadinessNonce() (string, error) {
	value := make([]byte, connectorReadyNonceBytes)
	if _, err := io.ReadFull(rand.Reader, value); err != nil {
		return "", err
	}
	const hexadecimal = "0123456789abcdef"
	encoded := make([]byte, len(value)*2)
	for index, character := range value {
		encoded[index*2] = hexadecimal[character>>4]
		encoded[index*2+1] = hexadecimal[character&0x0f]
	}
	return string(encoded), nil
}

func validConnectorRuntimeReadinessNonce(value string) bool {
	if len(value) != connectorReadyNonceBytes*2 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func writeConnectorRuntimeReadinessDocument(path string, document any) error {
	body, err := json.Marshal(document)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	writeNonce, err := newConnectorRuntimeReadinessNonce()
	if err != nil {
		return err
	}
	temporary := filepath.Join(filepath.Dir(path), ".connector-ready-write-"+writeNonce+".tmp")
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(body)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Chmod(path, 0o600)
}

func readPrivateConnectorRuntimeReadinessFile(path, label string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect connector readiness %s: %w", label, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return nil, fmt.Errorf("connector readiness %s is unsafe", label)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open connector readiness %s: %w", label, err)
	}
	opened, statErr := file.Stat()
	if statErr != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() ||
		(runtime.GOOS != "windows" && opened.Mode().Perm()&0o077 != 0) {
		_ = file.Close()
		return nil, fmt.Errorf("connector readiness %s changed while opening", label)
	}
	body, readErr := io.ReadAll(io.LimitReader(file, maximumConnectorReadyBytes+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return nil, fmt.Errorf(
			"read connector readiness %s: %w",
			label,
			errors.Join(readErr, closeErr),
		)
	}
	if len(body) > maximumConnectorReadyBytes {
		return nil, fmt.Errorf("connector readiness %s is too large", label)
	}
	return body, nil
}
