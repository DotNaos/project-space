package machineconnect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConnectorSupervisorRuntimeProcessesRestartAndUsesFixedEnvironment(t *testing.T) {
	fixture, executable := newMaintenanceRuntimeFixture(t)
	fixture.writeRestartControl(maintenanceTestOperation)
	template := filepath.Join(t.TempDir(), "restart-control.json")
	moveMaintenanceTestFile(t, fixture.maintenance.paths.ControlFile, template)
	t.Setenv(ConnectorRuntimeInstallSourceEnv, "untrusted-inherited-source")

	var stdout bytes.Buffer
	supervisor := maintenanceRuntimeSupervisor(
		t,
		fixture,
		executable,
		&stdout,
		"maintenance-control",
		"supervisor-control-template="+template,
	)
	err := supervisor.Run(context.Background())
	if !errors.Is(err, ErrConnectorSupervisorRestartRequired) {
		t.Fatalf("run error = %v, want managed restart", err)
	}
	state, err := fixture.maintenance.readState()
	if err != nil || state.Phase != connectorSupervisorPhasePendingHealth ||
		state.Operation != ConnectorSupervisorMaintenanceRestart {
		t.Fatalf("restart state = %#v, err=%v", state, err)
	}
	result := decodeSupervisorHelperResult(t, stdout.Bytes())
	if !result.MaintenancePathsOK || result.MaintenanceSource != "managed" ||
		result.ReleaseSigningKey != fixture.maintenance.releaseVerificationKeyFile ||
		result.CommandSigningKey != fixture.maintenance.commandVerificationKeyFile ||
		result.MaintenanceID != "" || result.MaintenanceState != "" {
		t.Fatalf("maintenance environment = %#v", result)
	}
}

func TestConnectorSupervisorRuntimeCommitsHealthyReconnectWithoutRestart(t *testing.T) {
	fixture, executable := newMaintenanceRuntimeFixture(t)
	fixture.writeRestartControl(maintenanceTestOperation)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}

	var stdout bytes.Buffer
	ready := filepath.Join(t.TempDir(), "connector-ready")
	supervisor := maintenanceRuntimeSupervisor(
		t,
		fixture,
		executable,
		&stdout,
		"maintenance-block",
		"supervisor-ready-file="+ready,
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() { runDone <- supervisor.Run(ctx) }()
	waitForMaintenanceTestFileWhileRunning(t, ready, runDone)
	fixture.writeDecision(maintenanceTestOperation, "commit")
	waitForMaintenanceStateRemovalWhileRunning(
		t,
		fixture.maintenance.paths.StateFile,
		runDone,
	)
	select {
	case err := <-runDone:
		t.Fatalf("committed connector exited instead of remaining active: %v", err)
	default:
	}
	cancel()
	err := <-runDone
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("run error = %v, want cancellation after committed child remained active", err)
	}
	result := decodeSupervisorHelperResult(t, stdout.Bytes())
	if result.MaintenanceID != maintenanceTestOperation ||
		result.MaintenanceState != string(ConnectorSupervisorEvidencePending) {
		t.Fatalf("pending reconnect evidence = %#v", result)
	}
}

func TestConnectorSupervisorRuntimeRollsBackRejectedReconnectAndRestarts(t *testing.T) {
	fixture, executable := newMaintenanceRuntimeFixture(t)
	fixture.writeRestartControl(maintenanceTestOperation)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}

	var stdout bytes.Buffer
	ready := filepath.Join(t.TempDir(), "connector-ready")
	supervisor := maintenanceRuntimeSupervisor(
		t,
		fixture,
		executable,
		&stdout,
		"maintenance-block",
		"supervisor-ready-file="+ready,
	)
	runDone := make(chan error, 1)
	go func() { runDone <- supervisor.Run(context.Background()) }()
	waitForMaintenanceTestFileWhileRunning(t, ready, runDone)
	fixture.writeDecision(maintenanceTestOperation, "rollback")
	err := <-runDone
	if !errors.Is(err, ErrConnectorSupervisorRestartRequired) {
		t.Fatalf("run error = %v, want rollback restart", err)
	}
	state, err := fixture.maintenance.readState()
	if err != nil || state.Phase != connectorSupervisorPhaseFailed ||
		state.FailureCode != "health-rejected" {
		t.Fatalf("restart rollback state = %#v, err=%v", state, err)
	}
	result := decodeSupervisorHelperResult(t, stdout.Bytes())
	if result.MaintenanceID != maintenanceTestOperation ||
		result.MaintenanceState != string(ConnectorSupervisorEvidencePending) {
		t.Fatalf("rollback reconnect evidence = %#v", result)
	}
}

func TestConnectorSupervisorRuntimeAcknowledgesRolledBackReconnect(t *testing.T) {
	fixture, executable := newMaintenanceRuntimeFixture(t)
	if fixture.maintenance.target == "windows-x64" {
		t.Skip("managed Windows update intentionally requires a different trusted boundary")
	}
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, fixture.maintenance.target),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	fixture.writeDecision(maintenanceTestOperation, "rollback")
	result, decided, err := fixture.maintenance.CheckHealthDecision()
	if err != nil || !decided || result.Outcome != ConnectorSupervisorMaintenanceRolledBack ||
		!result.RestartRequired || fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("rollback result = %#v decided=%v pointer=%s err=%v", result, decided, fixture.pointer(), err)
	}

	var stdout bytes.Buffer
	ready := filepath.Join(t.TempDir(), "connector-ready")
	supervisor := maintenanceRuntimeSupervisor(
		t,
		fixture,
		executable,
		&stdout,
		"maintenance-block",
		"supervisor-ready-file="+ready,
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() { runDone <- supervisor.Run(ctx) }()
	waitForMaintenanceTestFileWhileRunning(t, ready, runDone)
	fixture.writeDecision(maintenanceTestOperation, "rollback")
	waitForMaintenanceStateRemovalWhileRunning(
		t,
		fixture.maintenance.paths.StateFile,
		runDone,
	)
	assertMissing(t, fixture.maintenance.paths.DecisionFile)
	select {
	case err := <-runDone:
		t.Fatalf("acknowledged rollback connector exited instead of remaining active: %v", err)
	default:
	}
	cancel()
	if err := <-runDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("run error = %v, want cancellation after rollback acknowledgement", err)
	}
	actual := decodeSupervisorHelperResult(t, stdout.Bytes())
	if actual.MaintenanceID != maintenanceTestOperation ||
		actual.MaintenanceState != string(ConnectorSupervisorEvidenceRolledBack) {
		t.Fatalf("rolled-back reconnect evidence = %#v", actual)
	}
}

func TestConnectorSupervisorRuntimeDiscardsRejectedStartupControlOnce(t *testing.T) {
	fixture, executable := newMaintenanceRuntimeFixture(t)
	fixture.writeRestartControl(maintenanceTestOperation)
	control := fixture.readRawControl()
	control.Command.Grant.IssuedAt = "2026-07-14T09:58:00.000Z"
	control.Command.Grant.ExpiresAt = "2026-07-14T09:59:00.000Z"
	fixture.writeRawControl(control)

	supervisor := maintenanceRuntimeSupervisor(
		t,
		fixture,
		executable,
		io.Discard,
		"success",
	)
	err := supervisor.Run(context.Background())
	if maintenanceErrorCode(t, err) != "invalid-control" {
		t.Fatalf("first run error = %v", err)
	}
	assertMissing(t, fixture.maintenance.paths.ControlFile)
	if err := supervisor.Run(context.Background()); err != nil {
		t.Fatalf("current connector did not relaunch after rejected control: %v", err)
	}
}

func TestConnectorSupervisorRuntimeDerivesTrustRootsFromManagedRelease(t *testing.T) {
	fixture, executable := newMaintenanceRuntimeFixture(t)
	resolvedExecutable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		t.Fatal(err)
	}
	releaseDirectory := filepath.Dir(resolvedExecutable)
	commandKey := filepath.Join(releaseDirectory, connectorSupervisorCommandKeyFileName)
	releaseKey := filepath.Join(releaseDirectory, connectorSupervisorReleaseKeyFileName)
	copyMaintenanceTestFile(
		t,
		fixture.maintenance.commandVerificationKeyFile,
		commandKey,
		0o600,
	)
	copyMaintenanceTestFile(
		t,
		fixture.maintenance.releaseVerificationKeyFile,
		releaseKey,
		0o600,
	)
	t.Setenv(ConnectorCommandSigningKeyFileEnv, filepath.Join(t.TempDir(), "untrusted-command.pem"))
	t.Setenv(ConnectorReleaseSigningKeyFileEnv, filepath.Join(t.TempDir(), "untrusted-release.pem"))
	t.Setenv(ConnectorRuntimeInstallSourceEnv, "untrusted-inherited-source")

	var stdout bytes.Buffer
	store := newSupervisorTestStore(t, supervisorCredential(t), nil)
	supervisor, err := newConnectorSupervisor(store, ConnectorSupervisorOptions{
		Executable: executable,
		Stdout:     &stdout,
		Stderr:     io.Discard,
	}, []string{
		"-test.run=^TestConnectorSupervisorHelper$",
		"--",
		"supervisor-helper-mode=success",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	result := decodeSupervisorHelperResult(t, stdout.Bytes())
	if result.CommandSigningKey != commandKey || result.ReleaseSigningKey != releaseKey ||
		result.MaintenanceSource != "managed" {
		t.Fatalf("derived trust environment = %#v", result)
	}
}

func TestConnectorSupervisorRuntimeLaunchesCurrentSiblingAfterUpdateSwitch(t *testing.T) {
	target, err := CurrentConnectorSupervisorMaintenanceTarget()
	if err != nil {
		t.Skip(err)
	}
	if target == "windows-x64" {
		t.Skip("managed Windows update intentionally requires a different trusted boundary")
	}
	fixture, _ := newMaintenanceRuntimeFixture(t)
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, target),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	current := fixture.pointer()
	releaseDirectory := filepath.Join(
		fixture.maintenance.paths.VersionsRoot,
		filepath.Base(current),
	)
	executable := filepath.Join(releaseDirectory, "project-space-connector")
	replaceMaintenanceTestFile(t, os.Args[0], executable, 0o700)
	commandKey := filepath.Join(releaseDirectory, connectorSupervisorCommandKeyFileName)
	releaseKey := filepath.Join(releaseDirectory, connectorSupervisorReleaseKeyFileName)
	replaceMaintenanceTestFile(
		t,
		fixture.maintenance.commandVerificationKeyFile,
		commandKey,
		0o600,
	)
	replaceMaintenanceTestFile(
		t,
		fixture.maintenance.releaseVerificationKeyFile,
		releaseKey,
		0o600,
	)
	restartedMaintenance, err := NewConnectorSupervisorMaintenance(
		ConnectorSupervisorMaintenanceOptions{
			CommandVerificationKeyFile: commandKey,
			ExpectedMachineID:          "machine-191",
			HealthTimeout:              time.Minute,
			Now:                        func() time.Time { return maintenanceTestNow },
			ReleaseVerificationKeyFile: releaseKey,
			Target:                     target,
			ToolsRoot:                  fixture.root,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	fixture.maintenance = restartedMaintenance

	var stdout bytes.Buffer
	ready := filepath.Join(t.TempDir(), "connector-ready")
	supervisor := maintenanceRuntimeSupervisor(
		t,
		fixture,
		executable,
		&stdout,
		"maintenance-block",
		"supervisor-ready-file="+ready,
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() { runDone <- supervisor.Run(ctx) }()
	waitForMaintenanceTestFileWhileRunning(t, ready, runDone)
	fixture.writeDecision(maintenanceTestOperation, "commit")
	waitForMaintenanceStateRemovalWhileRunning(
		t,
		fixture.maintenance.paths.StateFile,
		runDone,
	)
	select {
	case err := <-runDone:
		t.Fatalf("committed updated connector exited instead of remaining active: %v", err)
	default:
	}
	cancel()
	if err := <-runDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("run error = %v, want cancellation after committed connector remained active", err)
	}
	result := decodeSupervisorHelperResult(t, stdout.Bytes())
	resolvedExecutable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		t.Fatal(err)
	}
	if result.Executable != resolvedExecutable {
		t.Fatalf("launched connector = %q, want current sibling %q", result.Executable, resolvedExecutable)
	}
	assertMissing(t, fixture.maintenance.paths.StateFile)
}

func TestConnectorSupervisorRuntimeRollsBackWhenUpdatedConnectorCannotStart(t *testing.T) {
	target, err := CurrentConnectorSupervisorMaintenanceTarget()
	if err != nil {
		t.Skip(err)
	}
	if target == "windows-x64" {
		t.Skip("managed Windows update intentionally requires a different trusted boundary")
	}
	fixture, executable := newMaintenanceRuntimeFixture(t)
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, target),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	if fixture.pointer() == maintenanceTestOldPointer {
		t.Fatal("update did not switch before reconnect")
	}
	supervisor := maintenanceRuntimeSupervisor(
		t,
		fixture,
		executable,
		io.Discard,
		"success",
	)
	err = supervisor.Run(context.Background())
	if !errors.Is(err, ErrConnectorSupervisorRestartRequired) {
		t.Fatalf("run error = %v, want rollback restart", err)
	}
	if fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("failed updated connector left pointer at %s", fixture.pointer())
	}
	state, stateErr := fixture.maintenance.readState()
	if stateErr != nil || state.Phase != connectorSupervisorPhaseRolledBack {
		t.Fatalf("failed start state = %#v, err=%v", state, stateErr)
	}
}

func newMaintenanceRuntimeFixture(
	t *testing.T,
) (*maintenanceTestFixture, string) {
	t.Helper()
	target, err := CurrentConnectorSupervisorMaintenanceTarget()
	if err != nil {
		t.Skip(err)
	}
	fixture := newMaintenanceTestFixture(t, target)
	name := "project-space-connector"
	if target == "windows-x64" {
		name += ".exe"
	}
	executable := filepath.Join(
		fixture.maintenance.paths.VersionsRoot,
		filepath.Base(maintenanceTestOldPointer),
		name,
	)
	copyMaintenanceTestFile(t, os.Args[0], executable, 0o700)
	return fixture, executable
}

func maintenanceRuntimeSupervisor(
	t *testing.T,
	fixture *maintenanceTestFixture,
	executable string,
	stdout io.Writer,
	mode string,
	extraArguments ...string,
) *ConnectorSupervisor {
	t.Helper()
	arguments := []string{
		"-test.run=^TestConnectorSupervisorHelper$",
		"--",
		"supervisor-helper-mode=" + mode,
	}
	arguments = append(arguments, extraArguments...)
	credential := supervisorCredential(t)
	credential.MachineID = "machine-191"
	supervisor, err := newConnectorSupervisor(
		newSupervisorTestStore(t, credential, nil),
		ConnectorSupervisorOptions{
			Executable:  executable,
			Maintenance: fixture.maintenance,
			Stdout:      stdout,
			Stderr:      io.Discard,
		},
		arguments,
	)
	if err != nil {
		t.Fatal(err)
	}
	return supervisor
}

func copyMaintenanceTestFile(t *testing.T, source, destination string, mode os.FileMode) {
	t.Helper()
	input, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if err := errors.Join(copyErr, syncErr, closeErr); err != nil {
		t.Fatal(err)
	}
}

func replaceMaintenanceTestFile(t *testing.T, source, destination string, mode os.FileMode) {
	t.Helper()
	if err := os.Remove(destination); err != nil {
		t.Fatal(err)
	}
	copyMaintenanceTestFile(t, source, destination, mode)
}

func moveMaintenanceTestFile(t *testing.T, source, destination string) {
	t.Helper()
	if err := os.Rename(source, destination); err != nil {
		t.Fatal(err)
	}
}

func waitForMaintenanceTestFileWhileRunning(
	t *testing.T,
	path string,
	runDone <-chan error,
) {
	t.Helper()
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-runDone:
			t.Fatalf("connector exited before becoming ready: %v", err)
		case <-ticker.C:
			if _, err := os.Stat(path); err == nil {
				return
			}
		case <-deadline.C:
			t.Fatalf("connector helper did not become ready at %s", path)
		}
	}
}

func waitForMaintenanceStateRemovalWhileRunning(
	t *testing.T,
	path string,
	runDone <-chan error,
) {
	t.Helper()
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-runDone:
			t.Fatalf("connector exited before maintenance commit: %v", err)
		case <-ticker.C:
			if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
				return
			} else if err != nil {
				t.Fatalf("inspect maintenance state: %v", err)
			}
		case <-deadline.C:
			t.Fatalf("maintenance state was not committed at %s", path)
		}
	}
}

func decodeSupervisorHelperResult(t *testing.T, body []byte) supervisorHelperResult {
	t.Helper()
	var result supervisorHelperResult
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("decode helper output %q: %v", string(body), err)
	}
	return result
}
