package machineconnect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const supervisorTestToken = "supervisor-test-machine-token"

type supervisorTestStore struct {
	credential      Credential
	err             error
	loadCalls       int
	keyLoads        int
	runtimeLockPath string
}

func (store *supervisorTestStore) Load() (Credential, error) {
	store.loadCalls++
	return store.credential, store.err
}

func (store *supervisorTestStore) LoadKey() (MachineKey, error) {
	store.keyLoads++
	return MachineKey{}, errors.New("supervisor must not load the private key")
}

func (*supervisorTestStore) SaveKey(MachineKey) error { return nil }
func (*supervisorTestStore) Save(Credential) error    { return nil }
func (*supervisorTestStore) Delete() error            { return nil }

func (store *supervisorTestStore) connectorRuntimeLockPath() string {
	return store.runtimeLockPath
}

type supervisorHelperResult struct {
	BuildID                    string `json:"buildId"`
	Executable                 string `json:"executable"`
	Version                    string `json:"version"`
	BackendURL                 string `json:"backendUrl"`
	MachineID                  string `json:"machineId"`
	MachineName                string `json:"machineName"`
	TokenMatches               bool   `json:"tokenMatches"`
	PrivateKeyPresent          bool   `json:"privateKeyPresent"`
	SecretInArguments          bool   `json:"secretInArguments"`
	SecretInEnvironment        bool   `json:"secretInEnvironment"`
	LegacyTokenPresent         bool   `json:"legacyTokenPresent"`
	UnexpectedProjectEnv       bool   `json:"unexpectedProjectEnv"`
	ProtocolMarkerOK           bool   `json:"protocolMarkerOk"`
	CommandSigningKeyOK        bool   `json:"commandSigningKeyOk"`
	CommandSigningKey          string `json:"commandSigningKey"`
	RuntimePathOK              bool   `json:"runtimePathOk"`
	MinimalFields              bool   `json:"minimalFields"`
	ShellAndLocaleOK           bool   `json:"shellAndLocaleOk"`
	MaintenancePathsOK         bool   `json:"maintenancePathsOk"`
	MaintenanceSource          string `json:"maintenanceSource"`
	MaintenanceState           string `json:"maintenanceState"`
	MaintenanceID              string `json:"maintenanceId"`
	ReleaseSigningKey          string `json:"releaseSigningKey"`
	ReleaseID                  string `json:"releaseId"`
	ReadyFile                  string `json:"readyFile"`
	ReadyAttemptNonce          string `json:"readyAttemptNonce"`
	CodexOperationSnapshotFile string `json:"codexOperationSnapshotFile"`
}

func TestConnectorSupervisorPassesMinimalCredentialOverStdin(t *testing.T) {
	credential := supervisorCredential(t)
	store := newSupervisorTestStore(t, credential, nil)
	t.Setenv("PROJECT_CONNECTOR_REGISTRATION_TOKEN", supervisorTestToken)
	t.Setenv("PROJECT_CONNECTOR_EU_REGISTRATION_TOKEN", "old-named-token")
	t.Setenv("PROJECT_CONNECTOR_TOKEN", "old-short-token")
	t.Setenv("PROJECT_SPACE_CONNECTOR_REGISTRATION_TOKEN", "old-project-space-token")
	t.Setenv("PROJECT_BACKEND_URL", "https://must-not-be-forwarded.example.test")
	t.Setenv("GH_TOKEN", "github-secret")
	t.Setenv("OP_SERVICE_ACCOUNT_TOKEN", "one-password-secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "aws-secret")
	t.Setenv("CLERK_SECRET_KEY", "clerk-secret")
	t.Setenv("PROJECT_DEPLOY_SECRET", "deploy-secret")
	t.Setenv(ConnectorCommandSigningKeyFileEnv, "/project-space/command-signing-public-key.pem")
	t.Setenv(CodexOperationSnapshotFileEnv, "/untrusted/codex-operations.json")
	home := filepath.Join(t.TempDir(), "runtime-home")
	t.Setenv("HOME", home)
	t.Setenv("PATH", strings.Join([]string{
		supervisorTestSystemPathEntry(),
		filepath.Join(home, ".bun", "bin"),
	}, string(os.PathListSeparator)))
	t.Setenv("SHELL", "/bin/test-shell")
	t.Setenv("LANG", "en_US.UTF-8")
	t.Setenv("LC_ALL", "C.UTF-8")
	t.Setenv("LC_CTYPE", "UTF-8")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	snapshotPath := testCodexOperationSnapshotPath(t)
	supervisor, err := newConnectorSupervisor(store, ConnectorSupervisorOptions{
		CodexOperationSnapshotPath: snapshotPath,
		ReadinessAttemptNonce:      strings.Repeat("1", 64),
		Executable:                 os.Args[0],
		Stdout:                     &stdout,
		Stderr:                     &stderr,
	}, []string{"-test.run=^TestConnectorSupervisorHelper$", "--", "supervisor-helper-mode=success"})
	if err != nil {
		t.Fatalf("create supervisor: %v", err)
	}
	if err := supervisor.Run(context.Background()); err != nil {
		t.Fatalf("run supervisor: %v", err)
	}
	if store.loadCalls != 1 {
		t.Fatalf("credential store load calls = %d, want 1", store.loadCalls)
	}
	if store.keyLoads != 0 {
		t.Fatalf("private machine key was loaded %d times", store.keyLoads)
	}

	var result supervisorHelperResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode helper output %q: %v", stdout.String(), err)
	}
	if result.Version != ConnectorRuntimeCredentialVersion ||
		result.BackendURL != credential.BackendURL || result.MachineID != credential.MachineID ||
		result.MachineName != credential.MachineName ||
		!result.TokenMatches {
		t.Fatalf("helper received the wrong runtime identity: %#v", result)
	}
	if result.PrivateKeyPresent || result.SecretInArguments || result.SecretInEnvironment || result.LegacyTokenPresent ||
		result.UnexpectedProjectEnv || !result.ProtocolMarkerOK || result.CommandSigningKey != "" ||
		!result.RuntimePathOK || !result.MinimalFields || !result.ShellAndLocaleOK ||
		!filepath.IsAbs(result.ReadyFile) || filepath.Base(result.ReadyFile) != connectorRuntimeReadyName ||
		result.CodexOperationSnapshotFile != snapshotPath ||
		result.ReadyAttemptNonce != strings.Repeat("1", 64) {
		t.Fatalf("secret escaped the stdin credential channel: %#v", result)
	}
	if stderr.String() != "connector helper stderr\n" {
		t.Fatalf("stderr was not passed through: %q", stderr.String())
	}
}

func TestConnectorSupervisorPassesFixedBuildIdentity(t *testing.T) {
	t.Setenv(ConnectorRuntimeBuildIDEnv, strings.Repeat("f", 40))
	t.Setenv(ConnectorRuntimeReleaseIDEnv, "v9.9.9")
	t.Setenv(ConnectorRuntimeReadyFileEnv, filepath.Join(t.TempDir(), connectorRuntimeReadyName))
	t.Setenv(ConnectorRuntimeReadyAttemptNonceEnv, strings.Repeat("2", 64))
	var stdout bytes.Buffer
	supervisor, err := newConnectorSupervisor(
		newSupervisorTestStore(t, supervisorCredential(t), nil),
		ConnectorSupervisorOptions{
			CodexOperationSnapshotPath: testCodexOperationSnapshotPath(t),
			BuildIdentity: ConnectorSupervisorBuildIdentity{
				BuildID:   strings.Repeat("a", 40),
				ReleaseID: "v0.4.1",
			},
			Executable: os.Args[0],
			Stdout:     &stdout,
			Stderr:     io.Discard,
		},
		[]string{"-test.run=^TestConnectorSupervisorHelper$", "--", "supervisor-helper-mode=success"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	result := decodeSupervisorHelperResult(t, stdout.Bytes())
	if result.BuildID != strings.Repeat("a", 40) || result.ReleaseID != "v0.4.1" ||
		result.ReadyFile != "" || result.ReadyAttemptNonce != "" || result.UnexpectedProjectEnv {
		t.Fatalf("fixed build identity = %#v", result)
	}
}

func TestConnectorSupervisorRejectsInvalidBuildIdentity(t *testing.T) {
	for name, identity := range map[string]ConnectorSupervisorBuildIdentity{
		"partial development": {ReleaseID: "dev"},
		"mutable release":     {BuildID: strings.Repeat("a", 40), ReleaseID: "latest"},
		"short build":         {BuildID: "abc", ReleaseID: "v0.4.1"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewConnectorSupervisor(
				newSupervisorTestStore(t, supervisorCredential(t), nil),
				ConnectorSupervisorOptions{BuildIdentity: identity, CodexOperationSnapshotPath: testCodexOperationSnapshotPath(t), Executable: os.Args[0]},
			); err == nil {
				t.Fatal("invalid build identity was accepted")
			}
		})
	}
}

func TestConnectorSupervisorRejectsInvalidReadinessAttempt(t *testing.T) {
	if _, err := NewConnectorSupervisor(
		newSupervisorTestStore(t, supervisorCredential(t), nil),
		ConnectorSupervisorOptions{
			CodexOperationSnapshotPath: testCodexOperationSnapshotPath(t),
			Executable:                 os.Args[0],
			ReadinessAttemptNonce:      "browser-selected-attempt",
		},
	); err == nil {
		t.Fatal("invalid readiness attempt was accepted")
	}
}

func TestConnectorSupervisorRejectsInvalidCodexOperationSnapshotPath(t *testing.T) {
	for name, snapshotPath := range map[string]string{
		"missing":          "",
		"relative":         CodexOperationSnapshotFilename,
		"unclean":          t.TempDir() + string(os.PathSeparator) + "nested" + string(os.PathSeparator) + ".." + string(os.PathSeparator) + CodexOperationSnapshotFilename,
		"mutable basename": filepath.Join(t.TempDir(), "renamed.json"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewConnectorSupervisor(
				newSupervisorTestStore(t, supervisorCredential(t), nil),
				ConnectorSupervisorOptions{
					CodexOperationSnapshotPath: snapshotPath,
					Executable:                 os.Args[0],
				},
			); err == nil {
				t.Fatalf("invalid Codex operation snapshot path %q was accepted", snapshotPath)
			}
		})
	}
}

func TestConnectorEnvironmentForwardsCodespacesMetadataAndRejectsOtherProjectValues(t *testing.T) {
	home := filepath.Join(t.TempDir(), "machine-home")
	existingEntries := []string{
		supervisorTestSystemPathEntry(),
		filepath.Join(home, ".bun", "bin"),
	}
	existingPath := strings.Join(existingEntries, string(os.PathListSeparator))
	environment := connectorEnvironment([]string{
		"PATH=" + existingPath,
		"HOME=" + home,
		ConnectorCommandSigningKeyFileEnv + "=/project-space/public-key.pem",
		CodexOperationSnapshotFileEnv + "=/untrusted/codex-operations.json",
		"CODESPACES=true",
		"CODESPACE_NAME=project-space--537-example",
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN=must-not-pass",
		"PROJECT_ARBITRARY_VALUE=must-not-pass",
		"GH_TOKEN=must-not-pass",
	})

	actual := environmentMap(environment)
	if _, found := actual[ConnectorCommandSigningKeyFileEnv]; found {
		t.Fatal("inherited command verification key path was forwarded")
	}
	if _, found := actual[CodexOperationSnapshotFileEnv]; found {
		t.Fatal("inherited Codex operation snapshot path was forwarded")
	}
	if actual[ConnectorRuntimeProtocolEnv] != ConnectorRuntimeCredentialVersion {
		t.Fatalf("connector runtime protocol = %q", actual[ConnectorRuntimeProtocolEnv])
	}
	if actual["CODESPACES"] != "true" ||
		actual["CODESPACE_NAME"] != "project-space--537-example" {
		t.Fatalf("Codespaces metadata was not forwarded: %#v", actual)
	}
	for _, forbidden := range []string{
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN",
		"PROJECT_ARBITRARY_VALUE",
		"GH_TOKEN",
	} {
		if _, found := actual[forbidden]; found {
			t.Fatalf("unexpected environment value %s was forwarded", forbidden)
		}
	}

	expectedPath := existingPath
	if runtime.GOOS != "windows" {
		expectedPath = strings.Join([]string{
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, ".local", "bin"),
			supervisorTestSystemPathEntry(),
		}, string(os.PathListSeparator))
	}
	if actual["PATH"] != expectedPath {
		t.Fatalf("connector PATH = %q, want %q", actual["PATH"], expectedPath)
	}
}

func TestConnectorSupervisorPropagatesLoadStartExitAndContextErrors(t *testing.T) {
	t.Run("load", func(t *testing.T) {
		store := newSupervisorTestStore(t, Credential{}, ErrCredentialNotFound)
		supervisor, err := NewConnectorSupervisor(store, ConnectorSupervisorOptions{CodexOperationSnapshotPath: testCodexOperationSnapshotPath(t), Executable: "missing"})
		if err != nil {
			t.Fatalf("create supervisor: %v", err)
		}
		err = supervisor.Run(context.Background())
		if !errors.Is(err, ErrCredentialNotFound) || store.loadCalls != 1 {
			t.Fatalf("run error = %v, load calls = %d", err, store.loadCalls)
		}
	})

	t.Run("start", func(t *testing.T) {
		store := newSupervisorTestStore(t, supervisorCredential(t), nil)
		supervisor, err := NewConnectorSupervisor(store, ConnectorSupervisorOptions{
			CodexOperationSnapshotPath: testCodexOperationSnapshotPath(t),
			Executable:                 t.TempDir() + "/missing-connector",
			Stdout:                     io.Discard,
			Stderr:                     io.Discard,
		})
		if err != nil {
			t.Fatalf("create supervisor: %v", err)
		}
		if err := supervisor.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "start connector companion") {
			t.Fatalf("run error = %v, want start failure", err)
		}
	})

	t.Run("exit", func(t *testing.T) {
		supervisor := supervisorForHelper(t, "exit", newSupervisorTestStore(t, supervisorCredential(t), nil), io.Discard, io.Discard)
		err := supervisor.Run(context.Background())
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 23 {
			t.Fatalf("run error = %v, want exit code 23", err)
		}
	})

	t.Run("context", func(t *testing.T) {
		supervisor := supervisorForHelper(t, "block", newSupervisorTestStore(t, supervisorCredential(t), nil), io.Discard, io.Discard)
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		err := supervisor.Run(ctx)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("run error = %v, want deadline exceeded", err)
		}
	})
}

func TestReadConnectorRuntimeCredentialRejectsUnsafeOrMultiplePayloads(t *testing.T) {
	valid := ConnectorRuntimeCredential{
		Version:    ConnectorRuntimeCredentialVersion,
		BackendURL: "https://projects.example.test",
		MachineID:  "machine-123",
		Token:      supervisorTestToken,
	}
	encoded, err := json.Marshal(valid)
	if err != nil {
		t.Fatalf("encode fixture: %v", err)
	}

	tests := map[string]string{
		"unknown field":     strings.TrimSuffix(string(encoded), "}") + `,"privateKey":"must-not-pass"}`,
		"multiple payloads": string(encoded) + string(encoded),
		"insecure backend":  `{"version":"` + ConnectorRuntimeCredentialVersion + `","backendUrl":"http://remote.example.test","machineId":"machine-123","credential":"token"}`,
		"wrong version":     `{"version":"v2","backendUrl":"https://projects.example.test","machineId":"machine-123","credential":"token"}`,
		"oversized":         strings.Repeat(" ", maxConnectorRuntimeCredentialSize+1),
	}
	for name, payload := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := ReadConnectorRuntimeCredential(strings.NewReader(payload)); err == nil {
				t.Fatal("expected runtime credential to be rejected")
			}
		})
	}
	if _, err := ReadConnectorRuntimeCredential(bytes.NewReader(encoded)); err != nil {
		t.Fatalf("valid runtime credential was rejected: %v", err)
	}
}

func TestConnectorRuntimeCredentialAllowsPortlessLocalhostBackend(t *testing.T) {
	credential := ConnectorRuntimeCredential{
		Version:    ConnectorRuntimeCredentialVersion,
		BackendURL: "http://project-space.localhost:1355",
		MachineID:  "machine-123",
		Token:      supervisorTestToken,
	}

	if err := validateConnectorRuntimeCredential(credential); err != nil {
		t.Fatalf("expected Portless localhost runtime credential to be valid, got %v", err)
	}
}

func TestConnectorRuntimeCredentialFormattingRedactsToken(t *testing.T) {
	credential := ConnectorRuntimeCredential{Token: supervisorTestToken}
	for _, formatted := range []string{credential.String(), credential.GoString(), fmt.Sprintf("%v", credential), fmt.Sprintf("%#v", credential)} {
		if strings.Contains(formatted, supervisorTestToken) {
			t.Fatalf("formatted credential exposed token: %s", formatted)
		}
	}
}

func TestConnectorSupervisorHelper(t *testing.T) {
	mode := supervisorHelperMode()
	if mode == "" {
		return
	}
	if mode == "exit" {
		os.Exit(23)
	}

	body, err := io.ReadAll(io.LimitReader(os.Stdin, maxConnectorRuntimeCredentialSize+1))
	if err != nil {
		os.Exit(24)
	}
	credential, err := ReadConnectorRuntimeCredential(bytes.NewReader(body))
	if err != nil {
		os.Exit(25)
	}
	if mode == "maintenance-control" {
		source := supervisorHelperArgument("supervisor-control-template=")
		target := os.Getenv(ConnectorSupervisorMaintenanceControlEnv)
		control, readErr := os.ReadFile(source)
		if readErr != nil || target == "" || os.WriteFile(target, control, 0o600) != nil {
			os.Exit(28)
		}
	}

	var fields map[string]any
	if err := json.Unmarshal(body, &fields); err != nil {
		os.Exit(26)
	}
	result := supervisorHelperResult{
		BuildID:           os.Getenv(ConnectorRuntimeBuildIDEnv),
		Executable:        helperExecutablePath(),
		Version:           credential.Version,
		BackendURL:        credential.BackendURL,
		MachineID:         credential.MachineID,
		MachineName:       os.Getenv(ConnectorRuntimeMachineNameEnv),
		TokenMatches:      credential.Token == supervisorTestToken,
		PrivateKeyPresent: fields["privateKey"] != nil,
		MinimalFields:     hasOnlyRuntimeCredentialFields(fields),
		RuntimePathOK:     supervisorRuntimePathIsExpected(),
		ShellAndLocaleOK: os.Getenv("SHELL") == "/bin/test-shell" &&
			os.Getenv("LANG") == "en_US.UTF-8" &&
			os.Getenv("LC_ALL") == "C.UTF-8" &&
			os.Getenv("LC_CTYPE") == "UTF-8",
		MaintenancePathsOK: filepath.IsAbs(os.Getenv(ConnectorSupervisorMaintenanceControlEnv)) &&
			filepath.IsAbs(os.Getenv(ConnectorSupervisorMaintenanceDecisionEnv)) &&
			filepath.IsAbs(os.Getenv(ConnectorSupervisorMaintenanceStagingEnv)),
		MaintenanceSource:          os.Getenv(ConnectorRuntimeInstallSourceEnv),
		MaintenanceState:           os.Getenv(ConnectorSupervisorMaintenanceStateEnv),
		MaintenanceID:              os.Getenv(ConnectorSupervisorMaintenanceOperationIDEnv),
		ReleaseSigningKey:          os.Getenv(ConnectorReleaseSigningKeyFileEnv),
		ReleaseID:                  os.Getenv(ConnectorRuntimeReleaseIDEnv),
		ReadyFile:                  os.Getenv(ConnectorRuntimeReadyFileEnv),
		ReadyAttemptNonce:          os.Getenv(ConnectorRuntimeReadyAttemptNonceEnv),
		CodexOperationSnapshotFile: os.Getenv(CodexOperationSnapshotFileEnv),
	}
	for _, argument := range os.Args {
		result.SecretInArguments = result.SecretInArguments ||
			strings.Contains(argument, supervisorTestToken) || strings.Contains(argument, "private-key")
	}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		result.SecretInEnvironment = result.SecretInEnvironment ||
			value == supervisorTestToken || isKnownSensitiveTestEnvironment(name)
		result.LegacyTokenPresent = result.LegacyTokenPresent || isLegacyConnectorTokenEnvironment(name)
		if name == ConnectorRuntimeProtocolEnv {
			result.ProtocolMarkerOK = value == ConnectorRuntimeCredentialVersion
		} else if name == ConnectorCommandSigningKeyFileEnv {
			result.CommandSigningKey = value
			result.CommandSigningKeyOK = value == "/project-space/command-signing-public-key.pem"
		} else if name == ConnectorRuntimeBuildIDEnv || name == ConnectorRuntimeReleaseIDEnv ||
			name == ConnectorRuntimeReadyFileEnv || name == ConnectorRuntimeReadyAttemptNonceEnv ||
			name == CodexOperationSnapshotFileEnv || name == ConnectorRuntimeMachineNameEnv {
			// Captured above from the fixed supervisor environment.
		} else if strings.HasPrefix(strings.ToUpper(name), "PROJECT_") {
			result.UnexpectedProjectEnv = true
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		os.Exit(27)
	}
	_, _ = fmt.Fprintln(os.Stderr, "connector helper stderr")
	if mode == "block" || mode == "maintenance-block" {
		if ready := supervisorHelperArgument("supervisor-ready-file="); ready != "" {
			if os.WriteFile(ready, []byte("ready\n"), 0o600) != nil {
				os.Exit(29)
			}
		}
		time.Sleep(time.Hour)
	}
	os.Exit(0)
}

func helperExecutablePath() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return executable
	}
	return resolved
}

func supervisorTestSystemPathEntry() string {
	return filepath.Join(string(os.PathSeparator), "supervisor-system-bin")
}

func supervisorRuntimePathIsExpected() bool {
	home := os.Getenv("HOME")
	existingPath := strings.Join([]string{
		supervisorTestSystemPathEntry(),
		filepath.Join(home, ".bun", "bin"),
	}, string(os.PathListSeparator))
	expected := existingPath
	if runtime.GOOS != "windows" {
		expected = strings.Join([]string{
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, ".local", "bin"),
			supervisorTestSystemPathEntry(),
		}, string(os.PathListSeparator))
	}
	return os.Getenv("PATH") == expected
}

func environmentMap(environment []string) map[string]string {
	values := make(map[string]string, len(environment))
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if found {
			values[name] = value
		}
	}
	return values
}

func supervisorHelperMode() string {
	for _, argument := range os.Args {
		if mode, found := strings.CutPrefix(argument, "supervisor-helper-mode="); found {
			return mode
		}
	}
	return ""
}

func supervisorHelperArgument(prefix string) string {
	for _, argument := range os.Args {
		if value, found := strings.CutPrefix(argument, prefix); found {
			return value
		}
	}
	return ""
}

func hasOnlyRuntimeCredentialFields(fields map[string]any) bool {
	if len(fields) != 4 {
		return false
	}
	for _, field := range []string{"version", "backendUrl", "machineId", "credential"} {
		if _, found := fields[field]; !found {
			return false
		}
	}
	return true
}

func isKnownSensitiveTestEnvironment(name string) bool {
	switch name {
	case "GH_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN", "AWS_SECRET_ACCESS_KEY", "CLERK_SECRET_KEY", "PROJECT_DEPLOY_SECRET":
		return true
	default:
		return false
	}
}

func supervisorCredential(t *testing.T) Credential {
	t.Helper()
	return Credential{
		BackendURL:  "https://projects.os-home.net",
		MachineID:   "machine-1",
		MachineName: "OS PC",
		Token:       supervisorTestToken,
		IssuedAt:    time.Now().UTC(),
	}
}

func newSupervisorTestStore(t *testing.T, credential Credential, err error) *supervisorTestStore {
	t.Helper()
	return &supervisorTestStore{
		credential:      credential,
		err:             err,
		runtimeLockPath: filepath.Join(t.TempDir(), "connector.runtime.lock"),
	}
}

func testCodexOperationSnapshotPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), CodexOperationSnapshotFilename)
}

func supervisorForHelper(t *testing.T, mode string, store CredentialStore, stdout, stderr io.Writer) *ConnectorSupervisor {
	t.Helper()
	supervisor, err := newConnectorSupervisor(store, ConnectorSupervisorOptions{
		CodexOperationSnapshotPath: testCodexOperationSnapshotPath(t),
		Executable:                 os.Args[0],
		Stdout:                     stdout,
		Stderr:                     stderr,
	}, []string{"-test.run=^TestConnectorSupervisorHelper$", "--", "supervisor-helper-mode=" + mode})
	if err != nil {
		t.Fatalf("create supervisor: %v", err)
	}
	return supervisor
}
