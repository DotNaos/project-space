package machineconnect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	ConnectorRuntimeCredentialVersion = "project-space.connector-runtime/v1"
	ConnectorRuntimeProtocolEnv       = "PROJECT_SPACE_CONNECTOR_RUNTIME_PROTOCOL"
	ConnectorRuntimeMachineNameEnv    = "PROJECT_SPACE_CONNECTOR_MACHINE_NAME"
	ConnectorCommandSigningKeyFileEnv = "PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY_FILE"
	CodexOperationSnapshotFileEnv     = "PROJECT_CODEX_OPERATION_SNAPSHOT_FILE"
	maxConnectorRuntimeCredentialSize = 16 * 1024
)

var connectorEnvironmentAllowlist = []string{
	"PATH",
	"HOME",
	"CODEX_HOME",
	"USER",
	"LOGNAME",
	"USERPROFILE",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMP",
	"TEMP",
	"TMPDIR",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"PATHEXT",
	"CODESPACES",
	"CODESPACE_NAME",
}

// ConnectorRuntimeCredential is the least-privilege identity passed to the
// companion connector. The long-lived machine private key stays in the CLI's
// credential store and is never shared with the child process.
type ConnectorRuntimeCredential struct {
	Version    string `json:"version"`
	BackendURL string `json:"backendUrl"`
	MachineID  string `json:"machineId"`
	Token      string `json:"credential"`
}

func (ConnectorRuntimeCredential) String() string {
	return "[redacted connector runtime credential]"
}

func (ConnectorRuntimeCredential) GoString() string {
	return "machineconnect.ConnectorRuntimeCredential{[redacted]}"
}

type ConnectorSupervisorOptions struct {
	BuildIdentity              ConnectorSupervisorBuildIdentity
	CodexOperationSnapshotPath string
	ReadinessAttemptNonce      string
	Executable                 string
	Maintenance                *ConnectorSupervisorMaintenance
	Stdout                     io.Writer
	Stderr                     io.Writer
}

// ConnectorSupervisor runs the companion connector for the lifetime of ctx.
// It owns credential loading so callers never need to handle the machine token.
type ConnectorSupervisor struct {
	store                      CredentialStore
	build                      ConnectorSupervisorBuildIdentity
	codexOperationSnapshotPath string
	readinessAttemptNonce      string
	executable                 string
	arguments                  []string
	maintenance                *ConnectorSupervisorMaintenance
	stdout                     io.Writer
	stderr                     io.Writer
	environ                    func() []string
}

func NewConnectorSupervisor(
	store CredentialStore,
	options ConnectorSupervisorOptions,
) (*ConnectorSupervisor, error) {
	return newConnectorSupervisor(store, options, nil)
}

func newConnectorSupervisor(
	store CredentialStore,
	options ConnectorSupervisorOptions,
	arguments []string,
) (*ConnectorSupervisor, error) {
	if store == nil {
		return nil, errors.New("connector supervisor credential store is missing")
	}
	if strings.TrimSpace(options.Executable) == "" || strings.ContainsRune(options.Executable, '\x00') {
		return nil, errors.New("connector supervisor executable is invalid")
	}
	stdout := options.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := options.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	if err := validateConnectorSupervisorBuildIdentity(options.BuildIdentity); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(options.CodexOperationSnapshotPath) ||
		filepath.Clean(options.CodexOperationSnapshotPath) != options.CodexOperationSnapshotPath ||
		filepath.Base(options.CodexOperationSnapshotPath) != CodexOperationSnapshotFilename {
		return nil, errors.New("connector supervisor Codex operation snapshot path is invalid")
	}
	if options.ReadinessAttemptNonce != "" &&
		!validConnectorRuntimeReadinessNonce(options.ReadinessAttemptNonce) {
		return nil, errors.New("connector supervisor readiness attempt is invalid")
	}
	return &ConnectorSupervisor{
		store:                      store,
		build:                      options.BuildIdentity,
		codexOperationSnapshotPath: options.CodexOperationSnapshotPath,
		readinessAttemptNonce:      options.ReadinessAttemptNonce,
		executable:                 options.Executable,
		arguments:                  append([]string(nil), arguments...),
		maintenance:                options.Maintenance,
		stdout:                     stdout,
		stderr:                     stderr,
		environ:                    os.Environ,
	}, nil
}

func (supervisor *ConnectorSupervisor) Run(ctx context.Context) (returnErr error) {
	if ctx == nil {
		return errors.New("connector supervisor context is missing")
	}
	lifetime, err := newConnectorSupervisorLifetime(supervisor.store)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := lifetime.Close(); closeErr != nil {
			returnErr = errors.Join(returnErr, closeErr)
		}
	}()
	credential, err := supervisor.store.Load()
	if err != nil {
		return fmt.Errorf("load connector machine credential: %w", err)
	}
	if err := validateCredential(credential); err != nil {
		return errors.New("load connector machine credential: invalid value")
	}
	runtimeCredential := ConnectorRuntimeCredential{
		Version:    ConnectorRuntimeCredentialVersion,
		BackendURL: credential.BackendURL,
		MachineID:  credential.MachineID,
		Token:      credential.Token,
	}
	payload, err := encodeConnectorRuntimeCredential(runtimeCredential)
	if err != nil {
		return err
	}

	maintenance, err := supervisor.resolveMaintenance(credential.MachineID)
	if err != nil {
		return err
	}
	return supervisor.runConnectorCompanion(
		ctx,
		lifetime,
		payload,
		credential.MachineName,
		maintenance,
	)
}

// ReadConnectorRuntimeCredential decodes exactly one bounded credential from
// stdin. It is suitable for the companion-side entrypoint.
func ReadConnectorRuntimeCredential(reader io.Reader) (ConnectorRuntimeCredential, error) {
	if reader == nil {
		return ConnectorRuntimeCredential{}, errors.New("connector runtime credential input is missing")
	}
	payload, err := io.ReadAll(io.LimitReader(reader, maxConnectorRuntimeCredentialSize+1))
	if err != nil {
		return ConnectorRuntimeCredential{}, errors.New("decode connector runtime credential: read input")
	}
	if len(payload) > maxConnectorRuntimeCredentialSize {
		return ConnectorRuntimeCredential{}, errors.New("decode connector runtime credential: payload is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var credential ConnectorRuntimeCredential
	if err := decoder.Decode(&credential); err != nil {
		return ConnectorRuntimeCredential{}, errors.New("decode connector runtime credential: invalid payload")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ConnectorRuntimeCredential{}, errors.New("decode connector runtime credential: expected one payload")
	}
	if err := validateConnectorRuntimeCredential(credential); err != nil {
		return ConnectorRuntimeCredential{}, err
	}
	return credential, nil
}

func encodeConnectorRuntimeCredential(credential ConnectorRuntimeCredential) ([]byte, error) {
	if err := validateConnectorRuntimeCredential(credential); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(credential)
	if err != nil {
		return nil, errors.New("encode connector runtime credential")
	}
	payload = append(payload, '\n')
	if len(payload) > maxConnectorRuntimeCredentialSize {
		return nil, errors.New("encode connector runtime credential: payload is too large")
	}
	return payload, nil
}

func validateConnectorRuntimeCredential(credential ConnectorRuntimeCredential) error {
	if credential.Version != ConnectorRuntimeCredentialVersion {
		return errors.New("connector runtime credential version is unsupported")
	}
	if len(credential.BackendURL) > 4096 {
		return errors.New("connector runtime credential backend URL is invalid")
	}
	trimmedBackendURL := strings.TrimSpace(credential.BackendURL)
	backendURL, err := url.Parse(trimmedBackendURL)
	if err != nil || backendURL.Host == "" || backendURL.User != nil ||
		trimmedBackendURL != credential.BackendURL ||
		(backendURL.Scheme != "https" && backendURL.Scheme != "http") ||
		backendURL.RawQuery != "" || backendURL.Fragment != "" {
		return errors.New("connector runtime credential backend URL is invalid")
	}
	if backendURL.Scheme != "https" && !isLoopbackHTTPHostname(backendURL.Hostname()) {
		return errors.New("connector runtime credential backend URL must use HTTPS")
	}
	if !validIdentifier(credential.MachineID) {
		return errors.New("connector runtime credential machine ID is invalid")
	}
	if !validOpaqueValue(credential.Token) {
		return errors.New("connector runtime authorization credential is invalid")
	}
	return nil
}

func connectorEnvironment(environment []string) []string {
	minimal := make([]string, 0, len(connectorEnvironmentAllowlist)+1)
	home, homeFound := exactEnvironmentValue(environment, "HOME")
	path, pathFound := exactEnvironmentValue(environment, "PATH")
	if runtime.GOOS != "windows" && homeFound && filepath.IsAbs(home) {
		path = connectorNonLoginPath(path, home)
		pathFound = true
	}
	for _, allowedName := range connectorEnvironmentAllowlist {
		value, found := exactEnvironmentValue(environment, allowedName)
		if allowedName == "PATH" {
			value, found = path, pathFound
		}
		if found {
			minimal = append(minimal, allowedName+"="+value)
		}
	}
	return append(
		minimal,
		ConnectorRuntimeProtocolEnv+"="+ConnectorRuntimeCredentialVersion,
	)
}

func connectorNonLoginPath(existingPath string, home string) string {
	entries := []string{
		filepath.Join(home, ".bun", "bin"),
		filepath.Join(home, ".local", "bin"),
	}
	entries = append(entries, filepath.SplitList(existingPath)...)
	unique := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if entry == "" {
			continue
		}
		if _, found := seen[entry]; found {
			continue
		}
		seen[entry] = struct{}{}
		unique = append(unique, entry)
	}
	return strings.Join(unique, string(os.PathListSeparator))
}

func exactEnvironmentValue(environment []string, name string) (string, bool) {
	for _, entry := range environment {
		entryName, value, found := strings.Cut(entry, "=")
		if found && (entryName == name || runtime.GOOS == "windows" && strings.EqualFold(entryName, name)) {
			return value, true
		}
	}
	return "", false
}

func isLegacyConnectorTokenEnvironment(name string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(name))
	return (strings.HasPrefix(normalized, "PROJECT_CONNECTOR_") ||
		strings.HasPrefix(normalized, "PROJECT_SPACE_CONNECTOR_")) &&
		strings.HasSuffix(normalized, "_TOKEN")
}
