package machineconnect

import (
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestConnectorSupervisorMaintenanceRestartsCurrentReleaseAndCommits(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "darwin-arm64")
	fixture.writeRestartControl(maintenanceTestOperation)

	result, err := fixture.maintenance.ProcessControl()
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != ConnectorSupervisorMaintenanceRestartRequested ||
		!result.RestartRequired || fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("restart result = %#v, pointer = %s", result, fixture.pointer())
	}
	if result.Evidence == nil || result.Evidence.State != ConnectorSupervisorEvidencePending {
		t.Fatalf("restart evidence = %#v", result.Evidence)
	}
	environment, envErr := fixture.maintenance.CompanionEnvironment(result.Evidence)
	if envErr != nil {
		t.Fatal(envErr)
	}
	wantEnvironment := []string{
		ConnectorSupervisorMaintenanceControlEnv + "=" + fixture.maintenance.paths.ControlFile,
		ConnectorSupervisorMaintenanceDecisionEnv + "=" + fixture.maintenance.paths.DecisionFile,
		ConnectorSupervisorMaintenanceStagingEnv + "=" + fixture.maintenance.paths.StagingRoot,
		ConnectorCommandSigningKeyFileEnv + "=" + fixture.maintenance.commandVerificationKeyFile,
		ConnectorReleaseSigningKeyFileEnv + "=" + fixture.maintenance.releaseVerificationKeyFile,
		ConnectorRuntimeInstallSourceEnv + "=managed",
		ConnectorSupervisorMaintenanceOperationIDEnv + "=" + maintenanceTestOperation,
		ConnectorSupervisorMaintenanceStateEnv + "=pending-health-check",
	}
	if !slices.Equal(environment, wantEnvironment) {
		t.Fatalf("companion environment = %#v, want %#v", environment, wantEnvironment)
	}

	recovered, err := fixture.maintenance.RecoverStartup()
	if err != nil || recovered.Outcome != ConnectorSupervisorMaintenancePendingHealth {
		t.Fatalf("recovered restart = %#v, %v", recovered, err)
	}
	fixture.writeDecision(maintenanceTestOperation, "commit")
	committed, decided, err := fixture.maintenance.CheckHealthDecision()
	if err != nil || !decided || committed.Outcome != ConnectorSupervisorMaintenanceSucceeded {
		t.Fatalf("committed restart = %#v, decided=%v, err=%v", committed, decided, err)
	}
	assertMissing(t, fixture.maintenance.paths.StateFile)
	if fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("restart changed pointer to %s", fixture.pointer())
	}
}

func TestConnectorSupervisorMaintenanceUpdatesAndCommits(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	artifactPath := fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, "linux-x64"),
	)

	result, err := fixture.maintenance.ProcessControl()
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != ConnectorSupervisorMaintenanceRestartRequested || !result.RestartRequired {
		t.Fatalf("update result = %#v", result)
	}
	nextPointer := fixture.pointer()
	if nextPointer == maintenanceTestOldPointer {
		t.Fatal("update did not switch the managed pointer")
	}
	for _, name := range []string{"project", "project-space-connector", "VERSION", "SHA256SUMS.txt"} {
		info, err := os.Lstat(filepath.Join(
			fixture.maintenance.paths.VersionsRoot,
			filepath.Base(nextPointer),
			name,
		))
		if err != nil || !info.Mode().IsRegular() {
			t.Fatalf("installed member %s: info=%v err=%v", name, info, err)
		}
	}
	assertMissing(t, artifactPath)
	assertMissing(t, fixture.maintenance.paths.ControlFile)

	fixture.writeDecision(maintenanceTestOperation, "commit")
	committed, decided, err := fixture.maintenance.CheckHealthDecision()
	if err != nil || !decided || committed.Outcome != ConnectorSupervisorMaintenanceSucceeded {
		t.Fatalf("commit = %#v, decided=%v err=%v", committed, decided, err)
	}
	if fixture.pointer() != nextPointer {
		t.Fatalf("commit changed pointer to %s", fixture.pointer())
	}
}

func TestConnectorSupervisorMaintenanceAcceptsLegacyLinuxBundleWithoutCodex(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	archive := maintenanceTestArchiveWithKeysAndCodex(
		t,
		"linux-x64",
		fixture.commandPrivate.Public().(ed25519.PublicKey),
		fixture.releasePrivate.Public().(ed25519.PublicKey),
		false,
	)
	fixture.writeUpdateControl(maintenanceTestOperation, archive)

	result, err := fixture.maintenance.ProcessControl()
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != ConnectorSupervisorMaintenanceRestartRequested || !result.RestartRequired {
		t.Fatalf("legacy update result = %#v", result)
	}
}

func TestConnectorSupervisorMaintenanceRollsBackFailedHealthCheck(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "darwin-arm64")
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, "darwin-arm64"),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	if fixture.pointer() == maintenanceTestOldPointer {
		t.Fatal("update did not switch before health check")
	}
	fixture.writeDecision(maintenanceTestOperation, "rollback")
	rolledBack, decided, err := fixture.maintenance.CheckHealthDecision()
	if err != nil || !decided || rolledBack.Outcome != ConnectorSupervisorMaintenanceRolledBack ||
		!rolledBack.RestartRequired {
		t.Fatalf("rollback = %#v, decided=%v err=%v", rolledBack, decided, err)
	}
	if fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("rollback pointer = %s", fixture.pointer())
	}

	recovered, err := fixture.maintenance.RecoverStartup()
	if err != nil || recovered.Evidence == nil ||
		recovered.Evidence.State != ConnectorSupervisorEvidenceRolledBack {
		t.Fatalf("rollback evidence = %#v, err=%v", recovered, err)
	}
	if err := fixture.maintenance.AcknowledgeOutcome(maintenanceTestOperation); err != nil {
		t.Fatal(err)
	}
	assertMissing(t, fixture.maintenance.paths.StateFile)
}

func TestConnectorSupervisorMaintenanceRollsBackOnTimeout(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, "linux-x64"),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	fixture.maintenance.now = func() time.Time { return maintenanceTestNow.Add(2 * time.Minute) }
	result, err := fixture.maintenance.HandleHealthTimeout()
	if err != nil || result.Outcome != ConnectorSupervisorMaintenanceRolledBack ||
		fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("timeout result = %#v pointer=%s err=%v", result, fixture.pointer(), err)
	}
}

func TestConnectorSupervisorMaintenanceRollsBackWhenConnectorExitsBeforeCommit(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, "linux-x64"),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	fixture.writeDecision(maintenanceTestOperation, "commit")
	result, err := fixture.maintenance.HandleConnectorExit()
	if err != nil || result.Outcome != ConnectorSupervisorMaintenanceRolledBack ||
		!result.RestartRequired {
		t.Fatalf("connector exit result = %#v, err=%v", result, err)
	}
	if fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("connector exit left pointer at %s", fixture.pointer())
	}
	assertMissing(t, fixture.maintenance.paths.DecisionFile)
}

func TestConnectorSupervisorMaintenanceAcceptsOnlyMatchingRollbackAcknowledgement(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, "linux-x64"),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	fixture.writeDecision(maintenanceTestOperation, "rollback")
	if result, decided, err := fixture.maintenance.CheckHealthDecision(); err != nil || !decided || result.Outcome != ConnectorSupervisorMaintenanceRolledBack {
		t.Fatalf("initial rollback = %#v decided=%v err=%v", result, decided, err)
	}

	fixture.writeDecision(maintenanceTestOperation, "commit")
	result, decided, err := fixture.maintenance.CheckHealthDecision()
	if maintenanceErrorCode(t, err) != "invalid-decision" || decided ||
		result.Outcome != ConnectorSupervisorMaintenanceRolledBack {
		t.Fatalf("commit acknowledgement = %#v decided=%v err=%v", result, decided, err)
	}
	assertMissing(t, fixture.maintenance.paths.DecisionFile)
	if _, err := fixture.maintenance.readState(); err != nil {
		t.Fatalf("invalid acknowledgement removed rollback state: %v", err)
	}

	fixture.writeDecision("different-operation", "rollback")
	result, decided, err = fixture.maintenance.CheckHealthDecision()
	if maintenanceErrorCode(t, err) != "stale-decision" || decided ||
		result.Outcome != ConnectorSupervisorMaintenanceRolledBack {
		t.Fatalf("stale acknowledgement = %#v decided=%v err=%v", result, decided, err)
	}
	assertMissing(t, fixture.maintenance.paths.DecisionFile)

	fixture.writeDecision(maintenanceTestOperation, "rollback")
	result, decided, err = fixture.maintenance.CheckHealthDecision()
	if err != nil || !decided || result.Outcome != ConnectorSupervisorMaintenanceRolledBack {
		t.Fatalf("matching acknowledgement = %#v decided=%v err=%v", result, decided, err)
	}
	assertMissing(t, fixture.maintenance.paths.StateFile)
	assertMissing(t, fixture.maintenance.paths.DecisionFile)
}

func TestConnectorSupervisorMaintenanceRejectsWrongDecisionThenTimesOut(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, "linux-x64"),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	fixture.writeDecision("different-operation", "commit")
	result, decided, err := fixture.maintenance.CheckHealthDecision()
	if maintenanceErrorCode(t, err) != "stale-decision" || decided ||
		result.Outcome != ConnectorSupervisorMaintenancePendingHealth {
		t.Fatalf("stale decision result = %#v decided=%v err=%v", result, decided, err)
	}
	assertMissing(t, fixture.maintenance.paths.DecisionFile)
	if fixture.pointer() == maintenanceTestOldPointer {
		t.Fatal("stale decision unexpectedly rolled back before timeout")
	}
	fixture.maintenance.now = func() time.Time { return maintenanceTestNow.Add(2 * time.Minute) }
	if _, err := fixture.maintenance.HandleHealthTimeout(); err != nil {
		t.Fatal(err)
	}
	if fixture.pointer() != maintenanceTestOldPointer {
		t.Fatal("timeout after stale decision did not roll back")
	}
}

func TestConnectorSupervisorMaintenanceRecoversInterruptedSwitch(t *testing.T) {
	t.Run("before pointer switch", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "linux-x64")
		fixture.writeUpdateControl(
			maintenanceTestOperation,
			maintenanceTestArchive(t, "linux-x64"),
		)
		interrupted := errors.New("simulated interruption")
		fixture.maintenance.beforePointerSwitch = func() error { return interrupted }
		if _, err := fixture.maintenance.ProcessControl(); !errors.Is(err, interrupted) {
			t.Fatalf("process error = %v", err)
		}
		if fixture.pointer() != maintenanceTestOldPointer {
			t.Fatal("pointer switched before interruption")
		}
		fixture.maintenance.beforePointerSwitch = nil
		result, err := fixture.maintenance.RecoverStartup()
		if err != nil || result.Outcome != ConnectorSupervisorMaintenanceRolledBack {
			t.Fatalf("recovery = %#v, %v", result, err)
		}
	})

	t.Run("after pointer switch", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "linux-x64")
		fixture.writeUpdateControl(
			maintenanceTestOperation,
			maintenanceTestArchive(t, "linux-x64"),
		)
		interrupted := errors.New("simulated interruption")
		fixture.maintenance.afterPointerSwitch = func() error { return interrupted }
		if _, err := fixture.maintenance.ProcessControl(); !errors.Is(err, interrupted) {
			t.Fatalf("process error = %v", err)
		}
		nextPointer := fixture.pointer()
		if nextPointer == maintenanceTestOldPointer {
			t.Fatal("pointer did not switch before interruption")
		}
		fixture.maintenance.afterPointerSwitch = nil
		result, err := fixture.maintenance.RecoverStartup()
		if err != nil || result.Outcome != ConnectorSupervisorMaintenancePendingHealth {
			t.Fatalf("recovery = %#v, %v", result, err)
		}
		fixture.writeDecision(maintenanceTestOperation, "rollback")
		if _, _, err := fixture.maintenance.CheckHealthDecision(); err != nil {
			t.Fatal(err)
		}
		if fixture.pointer() != maintenanceTestOldPointer {
			t.Fatalf("interrupted update rollback pointer = %s", fixture.pointer())
		}
	})
}

func TestConnectorSupervisorMaintenanceRestartFailureDoesNotChangeVersion(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "darwin-arm64")
	fixture.writeRestartControl(maintenanceTestOperation)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	fixture.maintenance.now = func() time.Time { return maintenanceTestNow.Add(2 * time.Minute) }
	result, err := fixture.maintenance.HandleHealthTimeout()
	if err != nil || result.Outcome != ConnectorSupervisorMaintenanceFailed ||
		!result.RestartRequired || fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("restart failure = %#v pointer=%s err=%v", result, fixture.pointer(), err)
	}
	environment, envErr := fixture.maintenance.CompanionEnvironment(nil)
	if envErr != nil || len(environment) != 6 {
		t.Fatalf("failed restart environment = %#v, %v", environment, envErr)
	}
}

func TestConnectorSupervisorMaintenanceExpiredRestartRecoveryRestoresCurrentVersion(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	fixture.writeRestartControl(maintenanceTestOperation)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	fixture.maintenance.now = func() time.Time { return maintenanceTestNow.Add(2 * time.Minute) }

	result, err := fixture.maintenance.RecoverStartup()
	if err != nil || result.Outcome != ConnectorSupervisorMaintenanceFailed ||
		result.RestartRequired || fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("expired restart recovery = %#v pointer=%s err=%v", result, fixture.pointer(), err)
	}
	state, stateErr := fixture.maintenance.readState()
	if stateErr != nil || state.Phase != connectorSupervisorPhaseFailed ||
		state.FailureCode != "health-timeout" {
		t.Fatalf("expired restart state = %#v, err=%v", state, stateErr)
	}
}

func TestConnectorSupervisorMaintenanceExpiredUpdateRecoveryStillRestartsRollback(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, "linux-x64"),
	)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	if fixture.pointer() == maintenanceTestOldPointer {
		t.Fatal("update did not switch before recovery")
	}
	fixture.maintenance.now = func() time.Time { return maintenanceTestNow.Add(2 * time.Minute) }

	result, err := fixture.maintenance.RecoverStartup()
	if err != nil || result.Outcome != ConnectorSupervisorMaintenanceRolledBack ||
		!result.RestartRequired || fixture.pointer() != maintenanceTestOldPointer {
		t.Fatalf("expired update recovery = %#v pointer=%s err=%v", result, fixture.pointer(), err)
	}
}

func TestConnectorSupervisorMaintenanceFailedRestartAllowsFreshControl(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "darwin-arm64")
	fixture.writeRestartControl(maintenanceTestOperation)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	fixture.writeDecision(maintenanceTestOperation, "rollback")
	failed, decided, err := fixture.maintenance.CheckHealthDecision()
	if err != nil || !decided || failed.Outcome != ConnectorSupervisorMaintenanceFailed ||
		!failed.RestartRequired {
		t.Fatalf("failed restart = %#v decided=%v err=%v", failed, decided, err)
	}
	assertMissing(t, fixture.maintenance.paths.DecisionFile)

	const retryOperation = "operation-restart-retry"
	fixture.writeRestartControl(retryOperation)
	retry, err := fixture.maintenance.ProcessControl()
	if err != nil || retry.OperationID != retryOperation ||
		retry.Outcome != ConnectorSupervisorMaintenanceRestartRequested ||
		!retry.RestartRequired {
		t.Fatalf("restart retry = %#v err=%v", retry, err)
	}
}
