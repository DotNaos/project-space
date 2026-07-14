package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

type installerLifecycleConnector struct {
	startCalls int
	stopCalls  int
	startErr   error
	stopErr    error
	onStart    func()
}

type installerLifecycleStore struct {
	*commandStore
	lockCalls           int
	purgeCalls          int
	releaseCalls        int
	runtimeLockCalls    int
	runtimeLockErr      error
	runtimeReleaseCalls int
}

type installerLifecycleBackend struct {
	*commandBackend
	revokeErr error
}

func (backend *installerLifecycleBackend) Revoke(
	context.Context,
	machineconnect.Credential,
) error {
	backend.revokeCalls++
	return backend.revokeErr
}

func (store *installerLifecycleStore) Lock(context.Context) (func() error, error) {
	store.lockCalls++
	return func() error {
		store.releaseCalls++
		return nil
	}, nil
}

func (store *installerLifecycleStore) Purge() error {
	store.purgeCalls++
	store.credential = nil
	store.key = nil
	return nil
}

func (store *installerLifecycleStore) LockConnectorRuntime(
	context.Context,
) (func() error, error) {
	store.runtimeLockCalls++
	if store.runtimeLockErr != nil {
		return nil, store.runtimeLockErr
	}
	return func() error {
		store.runtimeReleaseCalls++
		return nil
	}, nil
}

func (connector *installerLifecycleConnector) Start(context.Context) error {
	connector.startCalls++
	if connector.onStart != nil {
		connector.onStart()
	}
	return connector.startErr
}

func (connector *installerLifecycleConnector) Stop(context.Context) error {
	connector.stopCalls++
	return connector.stopErr
}

func connectorServiceReadinessIdentity(machineID string) machineconnect.ConnectorRuntimeReadinessIdentity {
	return machineconnect.ConnectorRuntimeReadinessIdentity{
		MachineID:    machineID,
		BuildID:      strings.Repeat("a", 40),
		ReleaseID:    "v0.4.1",
		AttemptNonce: strings.Repeat("1", 64),
	}
}

func writeConnectorServiceReadiness(
	t *testing.T,
	path string,
	identity machineconnect.ConnectorRuntimeReadinessIdentity,
) {
	t.Helper()
	body := fmt.Sprintf(
		`{"schema":"project-space.connector-runtime-ready/v2","machineId":%q,"buildId":%q,"releaseId":%q,"attemptNonce":%q}`+"\n",
		identity.MachineID,
		identity.BuildID,
		identity.ReleaseID,
		identity.AttemptNonce,
	)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write connector readiness fixture: %v", err)
	}
}

func connectedConnectorServiceDependencies(
	store machineconnect.CredentialStore,
	connector machineconnect.Connector,
	readinessPath string,
	timeout time.Duration,
) connectorMachineServiceDependencies {
	identity := connectorServiceReadinessIdentity("machine-1")
	return connectorMachineServiceDependencies{
		NewStore:              func() (machineconnect.CredentialStore, error) { return store, nil },
		NewConnector:          func() (machineconnect.Connector, error) { return connector, nil },
		ReadinessPath:         func() (string, error) { return readinessPath, nil },
		BeginReadiness:        machineconnect.BeginConnectorRuntimeReadinessAttempt,
		ClearReadinessAttempt: machineconnect.ClearConnectorRuntimeReadinessAttempt,
		WaitForReadiness:      machineconnect.WaitForConnectorRuntimeReadiness,
		ReadinessTimeout:      timeout,
		BuildIdentity: machineconnect.ConnectorSupervisorBuildIdentity{
			BuildID: identity.BuildID, ReleaseID: identity.ReleaseID,
		},
	}
}

func TestConnectorMachineServiceIsHiddenButRegistered(t *testing.T) {
	command, _, err := newConnectorCommand().Find([]string{"service", "stop"})
	if err != nil {
		t.Fatalf("find connector service stop: %v", err)
	}
	if command == nil || command.Name() != "stop" || command.Parent() == nil || !command.Parent().Hidden {
		t.Fatalf("connector service command is not registered as hidden: %#v", command)
	}
}

func TestConnectorMachineServiceStartSkipsUnconnectedInstall(t *testing.T) {
	store := &installerLifecycleStore{commandStore: &commandStore{}}
	command := newConnectorMachineServiceCommandWithDependencies(connectorMachineServiceDependencies{
		NewStore: func() (machineconnect.CredentialStore, error) { return store, nil },
		NewConnector: func() (machineconnect.Connector, error) {
			t.Fatal("created connector service without a stored credential")
			return nil, nil
		},
	})
	command.SetArgs([]string{"start-if-connected"})
	if err := command.Execute(); err != nil {
		t.Fatalf("start unconnected installation: %v", err)
	}
	if store.lockCalls != 1 || store.releaseCalls != 1 {
		t.Fatalf("unconnected restore lock calls = acquire %d release %d", store.lockCalls, store.releaseCalls)
	}
}

func TestConnectorMachineServiceStartRestoresConnectedInstall(t *testing.T) {
	store := &installerLifecycleStore{commandStore: &commandStore{
		credential: &machineconnect.Credential{MachineID: "machine-1"},
	}}
	readinessPath := filepath.Join(t.TempDir(), "connector-ready.json")
	connector := &installerLifecycleConnector{onStart: func() {
		attemptNonce, found, err := machineconnect.ConsumeConnectorRuntimeReadinessAttempt(
			readinessPath,
		)
		if err != nil || !found {
			t.Fatalf("consume readiness attempt: found=%v err=%v", found, err)
		}
		identity := connectorServiceReadinessIdentity("machine-1")
		identity.AttemptNonce = attemptNonce
		writeConnectorServiceReadiness(
			t,
			readinessPath,
			identity,
		)
	}}
	command := newConnectorMachineServiceCommandWithDependencies(
		connectedConnectorServiceDependencies(store, connector, readinessPath, time.Second),
	)
	command.SetArgs([]string{"start-if-connected"})
	if err := command.Execute(); err != nil {
		t.Fatalf("restore connected installation: %v", err)
	}
	if connector.startCalls != 1 || connector.stopCalls != 0 {
		t.Fatalf("restored connector calls = %#v", connector)
	}
	if store.lockCalls != 1 || store.releaseCalls != 1 {
		t.Fatalf("connected restore lock calls = acquire %d release %d", store.lockCalls, store.releaseCalls)
	}
}

func TestConnectorMachineServiceStartTimesOutWithoutAuthenticatedReconnect(t *testing.T) {
	store := &installerLifecycleStore{commandStore: &commandStore{
		credential: &machineconnect.Credential{MachineID: "machine-1"},
	}}
	connector := &installerLifecycleConnector{}
	readinessPath := filepath.Join(t.TempDir(), "connector-ready.json")
	command := newConnectorMachineServiceCommandWithDependencies(
		connectedConnectorServiceDependencies(store, connector, readinessPath, 60*time.Millisecond),
	)
	command.SetArgs([]string{"start-if-connected"})
	err := command.Execute()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("start without reconnect error = %v, want deadline exceeded", err)
	}
	if connector.startCalls != 1 {
		t.Fatalf("connector start calls = %d, want 1", connector.startCalls)
	}
}

func TestConnectorMachineServiceStartRejectsStaleOrWrongReadiness(t *testing.T) {
	for name, arrange := range map[string]func(*testing.T, string, *installerLifecycleConnector){
		"stale matching proof": func(t *testing.T, path string, _ *installerLifecycleConnector) {
			writeConnectorServiceReadiness(t, path, connectorServiceReadinessIdentity("machine-1"))
		},
		"wrong machine proof": func(t *testing.T, path string, connector *installerLifecycleConnector) {
			connector.onStart = func() {
				attemptNonce, found, err := machineconnect.ConsumeConnectorRuntimeReadinessAttempt(path)
				if err != nil || !found {
					t.Fatalf("consume readiness attempt: found=%v err=%v", found, err)
				}
				identity := connectorServiceReadinessIdentity("machine-2")
				identity.AttemptNonce = attemptNonce
				writeConnectorServiceReadiness(t, path, identity)
			}
		},
		"post-clear matching old attempt": func(
			t *testing.T,
			path string,
			connector *installerLifecycleConnector,
		) {
			connector.onStart = func() {
				identity := connectorServiceReadinessIdentity("machine-1")
				identity.AttemptNonce = strings.Repeat("2", 64)
				writeConnectorServiceReadiness(t, path, identity)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			store := &installerLifecycleStore{commandStore: &commandStore{
				credential: &machineconnect.Credential{MachineID: "machine-1"},
			}}
			connector := &installerLifecycleConnector{}
			readinessPath := filepath.Join(t.TempDir(), "connector-ready.json")
			arrange(t, readinessPath, connector)
			command := newConnectorMachineServiceCommandWithDependencies(
				connectedConnectorServiceDependencies(
					store,
					connector,
					readinessPath,
					60*time.Millisecond,
				),
			)
			command.SetArgs([]string{"start-if-connected"})
			if err := command.Execute(); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("start with %s error = %v, want deadline exceeded", name, err)
			}
		})
	}
}

func TestConnectorMachineServiceStopPreservesCredential(t *testing.T) {
	storeCalls := 0
	connector := &installerLifecycleConnector{}
	command := newConnectorMachineServiceCommandWithDependencies(connectorMachineServiceDependencies{
		NewStore: func() (machineconnect.CredentialStore, error) {
			storeCalls++
			return &commandStore{}, nil
		},
		NewConnector: func() (machineconnect.Connector, error) { return connector, nil },
	})
	command.SetArgs([]string{"stop"})
	if err := command.Execute(); err != nil {
		t.Fatalf("stop connected installation: %v", err)
	}
	if connector.stopCalls != 1 || storeCalls != 0 {
		t.Fatalf("stop calls = connector %d store %d", connector.stopCalls, storeCalls)
	}
}

func TestConnectorMachineServiceUninstallRevokesAndPurgesUnderOneLock(t *testing.T) {
	credential := &machineconnect.Credential{MachineID: "machine-1"}
	key, err := machineconnect.GenerateMachineKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate machine key: %v", err)
	}
	store := &installerLifecycleStore{commandStore: &commandStore{credential: credential, key: &key}}
	connector := &installerLifecycleConnector{}
	backend := &installerLifecycleBackend{
		commandBackend: &commandBackend{},
		revokeErr:      errors.New("backend unavailable"),
	}
	command := newConnectorMachineServiceCommandWithDependencies(connectorMachineServiceDependencies{
		LoadMachineConnection: fixedMachineConnectionDependencies(machineConnectionCommandDependencies{
			Backend: backend, Store: store, Connector: connector, Clock: machineconnect.RealClock{},
		}),
	})
	output := &bytes.Buffer{}
	command.SetErr(output)
	command.SetArgs([]string{"uninstall"})
	err = command.Execute()
	if err != nil {
		t.Fatalf("offline uninstall: %v", err)
	}
	if store.credential != nil || store.key != nil || store.purgeCalls != 1 {
		t.Fatalf("uninstall did not purge the local identity: %#v", store)
	}
	if backend.revokeCalls != 1 || connector.stopCalls != 1 {
		t.Fatalf("uninstall lifecycle = backend %#v connector %#v", backend, connector)
	}
	if store.lockCalls != 1 || store.releaseCalls != 1 {
		t.Fatalf("uninstall credential lock calls = acquire %d release %d", store.lockCalls, store.releaseCalls)
	}
	if store.runtimeLockCalls != 1 || store.runtimeReleaseCalls != 1 {
		t.Fatalf(
			"uninstall runtime barrier calls = acquire %d release %d",
			store.runtimeLockCalls,
			store.runtimeReleaseCalls,
		)
	}
	if !strings.Contains(output.String(), "server access may still need removal") {
		t.Fatalf("offline uninstall warning = %q", output.String())
	}
}

func TestConnectorMachineServiceUninstallPreservesIdentityAfterStopFailure(t *testing.T) {
	credential := &machineconnect.Credential{MachineID: "machine-1"}
	key, err := machineconnect.GenerateMachineKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate machine key: %v", err)
	}
	store := &installerLifecycleStore{commandStore: &commandStore{credential: credential, key: &key}}
	stopErr := errors.New("task stop failed")
	connector := &installerLifecycleConnector{stopErr: stopErr}
	backend := &installerLifecycleBackend{commandBackend: &commandBackend{}}
	command := newConnectorMachineServiceCommandWithDependencies(connectorMachineServiceDependencies{
		LoadMachineConnection: fixedMachineConnectionDependencies(machineConnectionCommandDependencies{
			Backend: backend, Store: store, Connector: connector, Clock: machineconnect.RealClock{},
		}),
	})
	command.SetArgs([]string{"uninstall"})
	err = command.Execute()
	if !errors.Is(err, stopErr) {
		t.Fatalf("uninstall error = %v, want stop failure", err)
	}
	if store.credential == nil || store.key == nil || store.purgeCalls != 0 {
		t.Fatalf("failed uninstall destroyed retryable identity: %#v", store)
	}
	if store.runtimeLockCalls != 0 {
		t.Fatalf("failed stop reached runtime barrier: %#v", store)
	}
}

func TestConnectorMachineServiceUninstallPreservesIdentityWhenRuntimeIsBusy(t *testing.T) {
	credential := &machineconnect.Credential{MachineID: "machine-1"}
	key, err := machineconnect.GenerateMachineKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate machine key: %v", err)
	}
	runtimeErr := errors.New("connector runtime is still active")
	store := &installerLifecycleStore{
		commandStore:   &commandStore{credential: credential, key: &key},
		runtimeLockErr: runtimeErr,
	}
	connector := &installerLifecycleConnector{}
	backend := &installerLifecycleBackend{commandBackend: &commandBackend{}}
	command := newConnectorMachineServiceCommandWithDependencies(connectorMachineServiceDependencies{
		LoadMachineConnection: fixedMachineConnectionDependencies(machineConnectionCommandDependencies{
			Backend: backend, Store: store, Connector: connector, Clock: machineconnect.RealClock{},
		}),
	})
	command.SetArgs([]string{"uninstall"})
	err = command.Execute()
	if !errors.Is(err, runtimeErr) {
		t.Fatalf("uninstall error = %v, want runtime barrier failure", err)
	}
	if store.credential == nil || store.key == nil || store.purgeCalls != 0 {
		t.Fatalf("busy-runtime uninstall destroyed retryable identity: %#v", store)
	}
	if store.runtimeLockCalls != 1 || store.runtimeReleaseCalls != 0 {
		t.Fatalf("busy-runtime barrier calls = %#v", store)
	}
}
