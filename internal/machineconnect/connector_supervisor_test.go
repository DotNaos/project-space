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
	"strings"
	"testing"
	"time"
)

const supervisorTestToken = "supervisor-test-machine-token"

type supervisorTestStore struct {
	credential Credential
	err        error
	loadCalls  int
	keyLoads   int
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

type supervisorHelperResult struct {
	Version              string `json:"version"`
	BackendURL           string `json:"backendUrl"`
	MachineID            string `json:"machineId"`
	TokenMatches         bool   `json:"tokenMatches"`
	PrivateKeyPresent    bool   `json:"privateKeyPresent"`
	SecretInArguments    bool   `json:"secretInArguments"`
	SecretInEnvironment  bool   `json:"secretInEnvironment"`
	LegacyTokenPresent   bool   `json:"legacyTokenPresent"`
	UnexpectedProjectEnv bool   `json:"unexpectedProjectEnv"`
	ProtocolMarkerOK     bool   `json:"protocolMarkerOk"`
	MinimalFields        bool   `json:"minimalFields"`
	ShellAndLocaleOK     bool   `json:"shellAndLocaleOk"`
}

func TestConnectorSupervisorPassesMinimalCredentialOverStdin(t *testing.T) {
	credential := supervisorCredential(t)
	store := &supervisorTestStore{credential: credential}
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
	t.Setenv("SHELL", "/bin/test-shell")
	t.Setenv("LANG", "en_US.UTF-8")
	t.Setenv("LC_ALL", "C.UTF-8")
	t.Setenv("LC_CTYPE", "UTF-8")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	supervisor, err := newConnectorSupervisor(store, ConnectorSupervisorOptions{
		Executable: os.Args[0],
		Stdout:     &stdout,
		Stderr:     &stderr,
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
		!result.TokenMatches {
		t.Fatalf("helper received the wrong runtime identity: %#v", result)
	}
	if result.PrivateKeyPresent || result.SecretInArguments || result.SecretInEnvironment || result.LegacyTokenPresent ||
		result.UnexpectedProjectEnv || !result.ProtocolMarkerOK || !result.MinimalFields || !result.ShellAndLocaleOK {
		t.Fatalf("secret escaped the stdin credential channel: %#v", result)
	}
	if stderr.String() != "connector helper stderr\n" {
		t.Fatalf("stderr was not passed through: %q", stderr.String())
	}
}

func TestConnectorSupervisorPropagatesLoadStartExitAndContextErrors(t *testing.T) {
	t.Run("load", func(t *testing.T) {
		store := &supervisorTestStore{err: ErrCredentialNotFound}
		supervisor, err := NewConnectorSupervisor(store, ConnectorSupervisorOptions{Executable: "missing"})
		if err != nil {
			t.Fatalf("create supervisor: %v", err)
		}
		err = supervisor.Run(context.Background())
		if !errors.Is(err, ErrCredentialNotFound) || store.loadCalls != 1 {
			t.Fatalf("run error = %v, load calls = %d", err, store.loadCalls)
		}
	})

	t.Run("start", func(t *testing.T) {
		store := &supervisorTestStore{credential: supervisorCredential(t)}
		supervisor, err := NewConnectorSupervisor(store, ConnectorSupervisorOptions{
			Executable: t.TempDir() + "/missing-connector",
			Stdout:     io.Discard,
			Stderr:     io.Discard,
		})
		if err != nil {
			t.Fatalf("create supervisor: %v", err)
		}
		if err := supervisor.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "start connector companion") {
			t.Fatalf("run error = %v, want start failure", err)
		}
	})

	t.Run("exit", func(t *testing.T) {
		supervisor := supervisorForHelper(t, "exit", &supervisorTestStore{credential: supervisorCredential(t)}, io.Discard, io.Discard)
		err := supervisor.Run(context.Background())
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 23 {
			t.Fatalf("run error = %v, want exit code 23", err)
		}
	})

	t.Run("context", func(t *testing.T) {
		supervisor := supervisorForHelper(t, "block", &supervisorTestStore{credential: supervisorCredential(t)}, io.Discard, io.Discard)
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
	if mode == "block" {
		time.Sleep(time.Hour)
	}

	var fields map[string]any
	if err := json.Unmarshal(body, &fields); err != nil {
		os.Exit(26)
	}
	result := supervisorHelperResult{
		Version:           credential.Version,
		BackendURL:        credential.BackendURL,
		MachineID:         credential.MachineID,
		TokenMatches:      credential.Token == supervisorTestToken,
		PrivateKeyPresent: fields["privateKey"] != nil,
		MinimalFields:     hasOnlyRuntimeCredentialFields(fields),
		ShellAndLocaleOK: os.Getenv("SHELL") == "/bin/test-shell" &&
			os.Getenv("LANG") == "en_US.UTF-8" &&
			os.Getenv("LC_ALL") == "C.UTF-8" &&
			os.Getenv("LC_CTYPE") == "UTF-8",
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
		} else if strings.HasPrefix(strings.ToUpper(name), "PROJECT_") {
			result.UnexpectedProjectEnv = true
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		os.Exit(27)
	}
	_, _ = fmt.Fprintln(os.Stderr, "connector helper stderr")
	os.Exit(0)
}

func supervisorHelperMode() string {
	for _, argument := range os.Args {
		if mode, found := strings.CutPrefix(argument, "supervisor-helper-mode="); found {
			return mode
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

func supervisorForHelper(t *testing.T, mode string, store CredentialStore, stdout, stderr io.Writer) *ConnectorSupervisor {
	t.Helper()
	supervisor, err := newConnectorSupervisor(store, ConnectorSupervisorOptions{
		Executable: os.Args[0],
		Stdout:     stdout,
		Stderr:     stderr,
	}, []string{"-test.run=^TestConnectorSupervisorHelper$", "--", "supervisor-helper-mode=" + mode})
	if err != nil {
		t.Fatalf("create supervisor: %v", err)
	}
	return supervisor
}
