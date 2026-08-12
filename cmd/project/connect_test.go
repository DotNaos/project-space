package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

type commandBackend struct {
	request     machineconnect.Request
	approval    machineconnect.Approval
	credential  machineconnect.Credential
	state       machineconnect.ConnectionState
	created     machineconnect.Machine
	healthCalls int
	createCalls int
	revokeCalls int
}

func (backend *commandBackend) Health(context.Context) error {
	backend.healthCalls++
	return nil
}

func (backend *commandBackend) CreateRequest(_ context.Context, machine machineconnect.Machine, _ machineconnect.MachineKey) (machineconnect.Request, error) {
	backend.createCalls++
	backend.created = machine
	return backend.request, nil
}

func (backend *commandBackend) PollRequest(context.Context, machineconnect.Request) (machineconnect.Approval, error) {
	return backend.approval, nil
}

func (backend *commandBackend) Exchange(context.Context, machineconnect.Request, string, machineconnect.MachineKey) (machineconnect.Credential, error) {
	return backend.credential, nil
}

func (backend *commandBackend) Connection(context.Context, machineconnect.Credential) (machineconnect.ConnectionState, error) {
	return backend.state, nil
}

func (backend *commandBackend) Revoke(context.Context, machineconnect.Credential) error {
	backend.revokeCalls++
	return nil
}

type commandStore struct {
	credential *machineconnect.Credential
	key        *machineconnect.MachineKey
}

func (store *commandStore) LoadKey() (machineconnect.MachineKey, error) {
	if store.key == nil {
		return machineconnect.MachineKey{}, machineconnect.ErrMachineKeyNotFound
	}
	return *store.key, nil
}

func (store *commandStore) SaveKey(key machineconnect.MachineKey) error {
	store.key = &key
	return nil
}

func (store *commandStore) Load() (machineconnect.Credential, error) {
	if store.credential == nil {
		return machineconnect.Credential{}, machineconnect.ErrCredentialNotFound
	}
	return *store.credential, nil
}

func (store *commandStore) Save(credential machineconnect.Credential) error {
	store.credential = &credential
	return nil
}

func (store *commandStore) Delete() error {
	store.credential = nil
	return nil
}

type commandConnector struct {
	startCalls int
	stopCalls  int
}

func (connector *commandConnector) Start(context.Context) error {
	connector.startCalls++
	return nil
}

func (connector *commandConnector) Stop(context.Context) error {
	connector.stopCalls++
	return nil
}

func TestConnectCommandKeepsApprovalOutOfJSONOutput(t *testing.T) {
	dependencies, backend, store, connector := testCommandDependencies()
	opened := 0
	dependencies.OpenURL = func(context.Context, string) error {
		opened++
		return nil
	}
	command := newConnectCommandWithDependencies(dependencies)
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)
	command.SetArgs([]string{"--json"})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if opened != 1 || connector.startCalls != 1 || store.credential == nil {
		t.Fatalf("connect side effects mismatch: opened=%d connector=%#v store=%#v", opened, connector, store)
	}
	if strings.Contains(stdout.String(), "approval.example") || strings.Contains(stdout.String(), "machine-secret") {
		t.Fatalf("stdout contains interactive or secret data: %s", stdout.String())
	}
	if !strings.Contains(stdout.String(), `"status": "online"`) || !strings.Contains(stderr.String(), "https://approval.example/connect") {
		t.Fatalf("unexpected output: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if backend.healthCalls != 1 || backend.createCalls != 1 {
		t.Fatalf("backend workflow did not run: %#v", backend)
	}
	if backend.created.ClientVersion != dependencies.Version {
		t.Fatalf("client version = %q, want %q", backend.created.ClientVersion, dependencies.Version)
	}
}

func TestConnectCommandNoOpenUsesPrintableFallback(t *testing.T) {
	dependencies, _, _, _ := testCommandDependencies()
	dependencies.OpenURL = func(context.Context, string) error {
		return errors.New("must not be called")
	}
	command := newConnectCommandWithDependencies(dependencies)
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)
	command.SetArgs([]string{"--no-open", "--name", "Office PC"})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(stderr.String(), "https://approval.example/connect") || !strings.Contains(stdout.String(), "connected and online") {
		t.Fatalf("unexpected output: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestConnectCommandDoesNotOpenBrowserOnHeadlessMachine(t *testing.T) {
	dependencies, _, _, _ := testCommandDependencies()
	dependencies.Headless = func() bool { return true }
	opened := 0
	dependencies.OpenURL = func(context.Context, string) error {
		opened++
		return nil
	}
	command := newConnectCommandWithDependencies(dependencies)
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute headless connect: %v", err)
	}
	if opened != 0 {
		t.Fatalf("headless connect opened a browser %d times", opened)
	}
}

func TestConnectCommandRejectsRetiredForegroundConnectorBeforeApproval(t *testing.T) {
	dependencies, backend, _, _ := testCommandDependencies()
	command := newConnectCommandWithDependencies(dependencies)
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--connector-mode", "foreground"})

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "canonical_runtime_required") {
		t.Fatalf("foreground retirement error = %v", err)
	}
	if backend.healthCalls != 0 || backend.createCalls != 0 {
		t.Fatalf("retired foreground mode requested approval: %#v", backend)
	}
}

func TestConnectCommandRejectsUnknownConnectorModeBeforeApproval(t *testing.T) {
	dependencies, backend, _, _ := testCommandDependencies()
	command := newConnectCommandWithDependencies(dependencies)
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--connector-mode", "automatic"})

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "managed or foreground") {
		t.Fatalf("connector mode error = %v", err)
	}
	if backend.healthCalls != 0 || backend.createCalls != 0 {
		t.Fatalf("invalid mode requested approval: %#v", backend)
	}
}

func TestWSLCanUseTheWindowsBrowserEvenOverSSH(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu-24.04")
	t.Setenv("SSH_CONNECTION", "client server")
	if isHeadlessMachine() {
		t.Fatal("WSL should use explorer.exe on the Windows host")
	}
}

func TestDefaultMachineConnectionDependenciesOnlyEnrollTheMachine(t *testing.T) {
	dependencies, err := defaultMachineConnectionDependencies()
	if err != nil {
		t.Fatalf("default dependencies: %v", err)
	}
	if !dependencies.Workflow.EnrollmentOnly {
		t.Fatal("default workflow still starts a permanent Connector service")
	}
	if dependencies.Connector != nil {
		t.Fatalf("default connector = %T, want nil", dependencies.Connector)
	}
}

func TestConnectCommandEnrollmentOnlyRegistersWithoutStartingAService(t *testing.T) {
	dependencies, backend, store, connector := testCommandDependencies()
	dependencies.Workflow.EnrollmentOnly = true
	backend.state = machineconnect.ConnectionOffline
	command := newConnectCommandWithDependencies(dependencies)
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--json"})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute enrollment-only connect: %v", err)
	}
	if connector.startCalls != 0 || connector.stopCalls != 0 {
		t.Fatalf("enrollment started a service: %#v", connector)
	}
	if store.credential == nil {
		t.Fatal("machine credential was not saved")
	}
	if !strings.Contains(stdout.String(), `"status": "registered"`) {
		t.Fatalf("unexpected enrollment output: %s", stdout.String())
	}
}

func TestMachineConnectionCommandHelpDoesNotResolveRuntimeDependencies(t *testing.T) {
	previousBackendURL := projectSpaceMachineBackendURL
	projectSpaceMachineBackendURL = "://invalid"
	t.Cleanup(func() {
		projectSpaceMachineBackendURL = previousBackendURL
	})

	commands := []struct {
		name    string
		command interface {
			Execute() error
			SetArgs([]string)
			SetOut(io.Writer)
			SetErr(io.Writer)
		}
	}{
		{name: "connect", command: newConnectCommand()},
		{name: "status", command: newMachineStatusCommand()},
		{name: "doctor", command: newMachineDoctorCommand()},
		{name: "disconnect", command: newDisconnectCommand()},
	}

	for _, candidate := range commands {
		t.Run(candidate.name, func(t *testing.T) {
			candidate.command.SetArgs([]string{"--help"})
			candidate.command.SetOut(&bytes.Buffer{})
			candidate.command.SetErr(&bytes.Buffer{})
			if err := candidate.command.Execute(); err != nil {
				t.Fatalf("help resolved runtime dependencies: %v", err)
			}
		})
	}
}

func TestMachineConnectionCommandReturnsDependencyErrorWithoutPanicking(t *testing.T) {
	previousBackendURL := projectSpaceMachineBackendURL
	projectSpaceMachineBackendURL = "://invalid"
	t.Cleanup(func() {
		projectSpaceMachineBackendURL = previousBackendURL
	})

	command := newConnectCommand()
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "configure Project Space backend") {
		t.Fatalf("dependency error = %v", err)
	}
}

func TestMachineManagementCommands(t *testing.T) {
	dependencies, backend, store, connector := testCommandDependencies()
	credential := backend.credential
	store.credential = &credential

	status := newMachineStatusCommandWithDependencies(dependencies)
	statusOutput := &bytes.Buffer{}
	status.SetOut(statusOutput)
	status.SetArgs([]string{"--json"})
	if err := status.Execute(); err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(statusOutput.String(), `"status": "online"`) {
		t.Fatalf("unexpected status: %s", statusOutput.String())
	}

	doctor := newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
		fixedMachineConnectionDependencies(dependencies),
		newProjectDirectoryDoctor(func() (string, error) { return t.TempDir(), nil }),
	)
	doctorOutput := &bytes.Buffer{}
	doctor.SetOut(doctorOutput)
	doctor.SetArgs([]string{"--json", "--fix", "--yes"})
	if err := doctor.Execute(); err != nil {
		t.Fatalf("doctor: %v", err)
	}
	if !strings.Contains(doctorOutput.String(), `"backendReachable": true`) {
		t.Fatalf("unexpected doctor result: %s", doctorOutput.String())
	}

	disconnect := newDisconnectCommandWithDependencies(dependencies)
	disconnect.SetOut(&bytes.Buffer{})
	if err := disconnect.Execute(); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if store.credential != nil || backend.revokeCalls != 1 || connector.stopCalls != 1 {
		t.Fatalf("disconnect mismatch: store=%#v backend=%#v connector=%#v", store, backend, connector)
	}
}

func TestDisconnectForegroundConnectionDoesNotRequireSystemd(t *testing.T) {
	dependencies, backend, store, managedConnector := testCommandDependencies()
	credential := backend.credential
	store.credential = &credential
	command := newDisconnectCommandWithDependencies(dependencies)
	command.SetOut(&bytes.Buffer{})
	command.SetArgs([]string{"--connector-mode", "foreground", "--json"})

	if err := command.Execute(); err != nil {
		t.Fatalf("disconnect foreground connection: %v", err)
	}
	if store.credential != nil || backend.revokeCalls != 1 || managedConnector.stopCalls != 0 {
		t.Fatalf(
			"foreground disconnect mismatch: store=%#v backend=%#v connector=%#v",
			store,
			backend,
			managedConnector,
		)
	}
}

func testCommandDependencies() (machineConnectionCommandDependencies, *commandBackend, *commandStore, *commandConnector) {
	now := time.Now().UTC()
	credential := machineconnect.Credential{
		BackendURL: "https://projects.os-home.net", MachineID: "machine-1", MachineName: "OS PC",
		Token: "machine-secret", IssuedAt: now,
	}
	backend := &commandBackend{
		request: machineconnect.Request{
			ID: "request-1", PollToken: "poll-secret", ApprovalURL: "https://approval.example/connect",
			ExpiresAt: now.Add(time.Minute), PollInterval: time.Second,
		},
		approval:   machineconnect.Approval{State: machineconnect.ApprovalApproved, Challenge: "exchange-secret"},
		credential: credential,
		state:      machineconnect.ConnectionOnline,
	}
	store := &commandStore{}
	connector := &commandConnector{}
	return machineConnectionCommandDependencies{
		Backend: backend, Store: store, Connector: connector, Clock: machineconnect.RealClock{},
		Hostname: func() (string, error) { return "os-pc", nil }, GOOS: "linux", GOARCH: "amd64",
		Version: "dev",
	}, backend, store, connector
}
