package machineconnect

import (
	"archive/tar"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConnectorSupervisorMaintenanceRejectsTamperedArtifact(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	path := fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchive(t, "linux-x64"),
	)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body[len(body)/2] ^= 0xff
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = fixture.maintenance.ProcessControl()
	if maintenanceErrorCode(t, err) != "artifact-integrity" {
		t.Fatalf("tamper error = %v", err)
	}
	if fixture.pointer() != maintenanceTestOldPointer {
		t.Fatal("tampered update changed pointer")
	}
}

func TestConnectorSupervisorMaintenanceVerifiesCommandAndReleaseSignatures(t *testing.T) {
	t.Run("tampered command signature", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "darwin-arm64")
		fixture.writeRestartControl(maintenanceTestOperation)
		body, err := os.ReadFile(fixture.maintenance.paths.ControlFile)
		if err != nil {
			t.Fatal(err)
		}
		var control map[string]any
		if err := json.Unmarshal(body, &control); err != nil {
			t.Fatal(err)
		}
		grant := control["command"].(map[string]any)["grant"].(map[string]any)
		grant["signature"] = strings.Repeat("A", 86)
		body, _ = json.Marshal(control)
		if err := os.WriteFile(fixture.maintenance.paths.ControlFile, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("tampered command error = %v", err)
		}
	})

	t.Run("wrong command key", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "darwin-arm64")
		fixture.writeRestartControl(maintenanceTestOperation)
		wrongPublic, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		writeMaintenanceTestPublicKey(t, fixture.maintenance.commandVerificationKeyFile, wrongPublic)
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("wrong command key error = %v", err)
		}
	})

	t.Run("noncanonical command signature", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "darwin-arm64")
		fixture.writeRestartControl(maintenanceTestOperation)
		control := fixture.readRawControl()
		control.Command.Grant.Signature = nonCanonicalMaintenanceSignature(
			t,
			control.Command.Grant.Signature,
		)
		body, err := json.Marshal(control)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixture.maintenance.paths.ControlFile, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("noncanonical command signature error = %v", err)
		}
	})

	t.Run("tampered release signature with valid command", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "linux-x64")
		fixture.writeUpdateControl(
			maintenanceTestOperation,
			maintenanceTestArchive(t, "linux-x64"),
		)
		body, err := os.ReadFile(fixture.maintenance.paths.ControlFile)
		if err != nil {
			t.Fatal(err)
		}
		var control connectorSupervisorRawControl
		if err := decodeConnectorSupervisorJSON(body, &control); err != nil {
			t.Fatal(err)
		}
		var plan connectorSupervisorUpdatePlan
		if err := decodeConnectorSupervisorJSON(control.Command.Plan, &plan); err != nil {
			t.Fatal(err)
		}
		plan.Release.Signature = strings.Repeat("A", 86)
		control.Command.Plan, err = json.Marshal(plan)
		if err != nil {
			t.Fatal(err)
		}
		control.Command.Grant.PlanSHA256, err = connectorSupervisorRawDigest(control.Command.Plan)
		if err != nil {
			t.Fatal(err)
		}
		control.Command.Grant.Signature = base64.RawURLEncoding.EncodeToString(
			ed25519.Sign(fixture.commandPrivate, canonicalConnectorSupervisorGrant(control.Command.Grant)),
		)
		body, _ = json.Marshal(control)
		if err := os.WriteFile(fixture.maintenance.paths.ControlFile, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("tampered release error = %v", err)
		}
	})

	t.Run("wrong release key", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "linux-x64")
		fixture.writeUpdateControl(
			maintenanceTestOperation,
			maintenanceTestArchive(t, "linux-x64"),
		)
		wrongPublic, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		writeMaintenanceTestPublicKey(t, fixture.maintenance.releaseVerificationKeyFile, wrongPublic)
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("wrong release key error = %v", err)
		}
	})

	t.Run("noncanonical release signature", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "linux-x64")
		fixture.writeUpdateControl(
			maintenanceTestOperation,
			maintenanceTestArchive(t, "linux-x64"),
		)
		control := fixture.readRawControl()
		var plan connectorSupervisorUpdatePlan
		if err := decodeConnectorSupervisorJSON(control.Command.Plan, &plan); err != nil {
			t.Fatal(err)
		}
		plan.Release.Signature = nonCanonicalMaintenanceSignature(t, plan.Release.Signature)
		planBody, err := json.Marshal(plan)
		if err != nil {
			t.Fatal(err)
		}
		control.Command.Plan = planBody
		control.Command.Grant.PlanSHA256, err = connectorSupervisorRawDigest(planBody)
		if err != nil {
			t.Fatal(err)
		}
		fixture.writeRawControl(control)
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("noncanonical release signature error = %v", err)
		}
	})
}

func nonCanonicalMaintenanceSignature(t *testing.T, value string) string {
	t.Helper()
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	if len(value) == 0 {
		t.Fatal("signature is empty")
	}
	index := strings.IndexByte(alphabet, value[len(value)-1])
	if index < 0 || index&0x0f != 0 {
		t.Fatalf("signature has an unexpected canonical suffix: %q", value)
	}
	alias := value[:len(value)-1] + string(alphabet[index+1])
	canonicalBytes, canonicalErr := base64.RawURLEncoding.DecodeString(value)
	aliasBytes, aliasErr := base64.RawURLEncoding.DecodeString(alias)
	if canonicalErr != nil || aliasErr != nil || !bytes.Equal(canonicalBytes, aliasBytes) {
		t.Fatal("test signature alias does not decode to the same bytes")
	}
	if _, err := connectorSupervisorSignatureEncoding.DecodeString(alias); err == nil {
		t.Fatal("strict signature encoding unexpectedly accepted the alias")
	}
	return alias
}

func TestConnectorSupervisorMaintenanceRejectsCommandOutsideValidityWindow(t *testing.T) {
	tests := []struct {
		name      string
		issuedAt  string
		expiresAt string
	}{
		{
			name:      "expired",
			issuedAt:  "2026-07-14T09:58:00.000Z",
			expiresAt: "2026-07-14T09:59:00.000Z",
		},
		{
			name:      "future issued",
			issuedAt:  "2026-07-14T10:01:00.000Z",
			expiresAt: "2026-07-14T10:01:30.000Z",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newMaintenanceTestFixture(t, "darwin-arm64")
			fixture.writeRestartControl(maintenanceTestOperation)
			control := fixture.readRawControl()
			control.Command.Grant.IssuedAt = test.issuedAt
			control.Command.Grant.ExpiresAt = test.expiresAt
			fixture.writeRawControl(control)

			_, err := fixture.maintenance.ProcessControl()
			if maintenanceErrorCode(t, err) != "invalid-control" {
				t.Fatalf("validity error = %v", err)
			}
			assertMissing(t, fixture.maintenance.paths.ControlFile)
		})
	}
}

func TestConnectorSupervisorMaintenanceRejectsReleaseOutsideValidityWindow(t *testing.T) {
	tests := []struct {
		name      string
		issuedAt  string
		expiresAt string
	}{
		{
			name:      "expired",
			issuedAt:  "2025-07-14T10:00:00.000Z",
			expiresAt: "2026-07-14T10:00:00.000Z",
		},
		{
			name:      "future issued",
			issuedAt:  "2026-07-14T10:06:00.000Z",
			expiresAt: "2027-07-14T10:06:00.000Z",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newMaintenanceTestFixture(t, "linux-x64")
			fixture.writeUpdateControl(
				maintenanceTestOperation,
				maintenanceTestArchive(t, "linux-x64"),
			)
			control := fixture.readRawControl()
			var plan connectorSupervisorUpdatePlan
			if err := decodeConnectorSupervisorJSON(control.Command.Plan, &plan); err != nil {
				t.Fatal(err)
			}
			plan.Release.Manifest.IssuedAt = test.issuedAt
			plan.Release.Manifest.ExpiresAt = test.expiresAt
			fixture.resignRelease(&plan.Release)
			planBody, err := json.Marshal(plan)
			if err != nil {
				t.Fatal(err)
			}
			control.Command.Plan = planBody
			control.Command.Grant.PlanSHA256, err = connectorSupervisorRawDigest(planBody)
			if err != nil {
				t.Fatal(err)
			}
			fixture.writeRawControl(control)

			_, err = fixture.maintenance.ProcessControl()
			if maintenanceErrorCode(t, err) != "invalid-control" {
				t.Fatalf("release validity error = %v", err)
			}
			assertMissing(t, fixture.maintenance.paths.ControlFile)
		})
	}
}

func TestConnectorSupervisorMaintenanceRejectsCommandForDifferentMachine(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "darwin-arm64")
	fixture.writeRestartControl(maintenanceTestOperation)
	control := fixture.readRawControl()
	var plan connectorSupervisorRestartPlan
	if err := decodeConnectorSupervisorJSON(control.Command.Plan, &plan); err != nil {
		t.Fatal(err)
	}
	plan.MachineID = "different-machine"
	planBody, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	control.Command.Plan = planBody
	control.Command.Grant.MachineID = plan.MachineID
	control.Command.Grant.PlanSHA256, err = connectorSupervisorRawDigest(planBody)
	if err != nil {
		t.Fatal(err)
	}
	fixture.writeRawControl(control)

	_, err = fixture.maintenance.ProcessControl()
	if maintenanceErrorCode(t, err) != "invalid-control" {
		t.Fatalf("machine binding error = %v", err)
	}
	assertMissing(t, fixture.maintenance.paths.ControlFile)
}

func TestConnectorSupervisorMaintenanceRejectsWrongTargetAndStagingPath(t *testing.T) {
	t.Run("target", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "darwin-arm64")
		fixture.writeRestartControl(maintenanceTestOperation)
		fixture.maintenance.target = "linux-x64"
		_, err := fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "wrong-target" {
			t.Fatalf("wrong target error = %v", err)
		}
	})

	t.Run("path", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "linux-x64")
		fixture.writeUpdateControl(
			maintenanceTestOperation,
			maintenanceTestArchive(t, "linux-x64"),
		)
		body, err := os.ReadFile(fixture.maintenance.paths.ControlFile)
		if err != nil {
			t.Fatal(err)
		}
		var control map[string]any
		if err := json.Unmarshal(body, &control); err != nil {
			t.Fatal(err)
		}
		control["artifact"].(map[string]any)["path"] = filepath.Join(t.TempDir(), "artifact.tar.gz")
		body, _ = json.Marshal(control)
		if err := os.WriteFile(fixture.maintenance.paths.ControlFile, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("wrong path error = %v", err)
		}
		if fixture.pointer() != maintenanceTestOldPointer {
			t.Fatal("wrong path update changed pointer")
		}
	})
}

func TestConnectorSupervisorMaintenanceRejectsTraversalAndLinks(t *testing.T) {
	tests := []struct {
		name    string
		archive func(*testing.T) []byte
	}{
		{
			name: "traversal",
			archive: func(t *testing.T) []byte {
				return maintenanceMaliciousArchive(t, "../../escape", tar.TypeReg)
			},
		},
		{
			name: "symlink",
			archive: func(t *testing.T) []byte {
				root := "project-space-machine-tools-linux-x64-v1.2.3"
				return maintenanceMaliciousArchive(t, root+"/project", tar.TypeSymlink)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newMaintenanceTestFixture(t, "linux-x64")
			fixture.writeUpdateControl(maintenanceTestOperation, test.archive(t))
			_, err := fixture.maintenance.ProcessControl()
			if maintenanceErrorCode(t, err) != "artifact-installation" {
				t.Fatalf("unsafe archive error = %v", err)
			}
			if fixture.pointer() != maintenanceTestOldPointer {
				t.Fatal("unsafe archive changed pointer")
			}
		})
	}
}

func TestConnectorSupervisorMaintenanceRejectsBundleWithoutDedicatedTrustRoots(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "linux-x64")
	sharedPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fixture.writeUpdateControl(
		maintenanceTestOperation,
		maintenanceTestArchiveWithKeys(t, "linux-x64", sharedPublic, sharedPublic),
	)
	_, err = fixture.maintenance.ProcessControl()
	if maintenanceErrorCode(t, err) != "artifact-installation" {
		t.Fatalf("shared trust root error = %v", err)
	}
	if fixture.pointer() != maintenanceTestOldPointer {
		t.Fatal("bundle with shared trust roots changed pointer")
	}
}

func TestConnectorSupervisorMaintenanceRejectsUnknownAndDuplicateControlFields(t *testing.T) {
	t.Run("unknown", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "darwin-arm64")
		fixture.writeRestartControl(maintenanceTestOperation)
		body, err := os.ReadFile(fixture.maintenance.paths.ControlFile)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.Replace(body, []byte(`"schema":`), []byte(`"extra":true,"schema":`), 1)
		if err := os.WriteFile(fixture.maintenance.paths.ControlFile, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("unknown field error = %v", err)
		}
	})

	t.Run("duplicate", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "darwin-arm64")
		fixture.writeRestartControl(maintenanceTestOperation)
		body, err := os.ReadFile(fixture.maintenance.paths.ControlFile)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.Replace(
			body,
			[]byte(`"schema":"`+ConnectorSupervisorControlSchema+`"`),
			[]byte(`"schema":"`+ConnectorSupervisorControlSchema+`","schema":"`+
				ConnectorSupervisorControlSchema+`"`),
			1,
		)
		if err := os.WriteFile(fixture.maintenance.paths.ControlFile, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("duplicate field error = %v", err)
		}
	})
}

func TestConnectorSupervisorMaintenanceRejectsPublicOrSymlinkStatePaths(t *testing.T) {
	t.Run("public control", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "darwin-arm64")
		fixture.writeRestartControl(maintenanceTestOperation)
		if err := os.Chmod(fixture.maintenance.paths.ControlFile, 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("public control error = %v", err)
		}
	})

	t.Run("symlink control", func(t *testing.T) {
		fixture := newMaintenanceTestFixture(t, "darwin-arm64")
		outside := filepath.Join(t.TempDir(), "outside.json")
		if err := os.WriteFile(outside, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, fixture.maintenance.paths.ControlFile); err != nil {
			t.Fatal(err)
		}
		_, err := fixture.maintenance.ProcessControl()
		if maintenanceErrorCode(t, err) != "invalid-control" {
			t.Fatalf("symlink control error = %v", err)
		}
	})
}

func TestConnectorSupervisorMaintenanceReportsWindowsUpdateUnsupported(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "windows-x64")
	fixture.writeUpdateControl(maintenanceTestOperation, []byte("signed-windows-installer"))
	_, err := fixture.maintenance.ProcessControl()
	if maintenanceErrorCode(t, err) != "unsupported-update" {
		t.Fatalf("Windows update error = %v", err)
	}
	if fixture.pointer() != maintenanceTestOldPointer {
		t.Fatal("unsupported Windows update changed pointer")
	}
	assertMissing(t, fixture.maintenance.paths.ControlFile)
}

func TestConnectorSupervisorMaintenanceDoesNotAcceptArbitraryDecision(t *testing.T) {
	fixture := newMaintenanceTestFixture(t, "darwin-arm64")
	fixture.writeRestartControl(maintenanceTestOperation)
	if _, err := fixture.maintenance.ProcessControl(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		fixture.maintenance.paths.DecisionFile,
		[]byte(`{"schema":"project-space.connector-runtime-supervisor-decision/v1",`+
			`"operationId":"operation-191","action":"commit","command":"rm -rf /"}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	result, decided, err := fixture.maintenance.CheckHealthDecision()
	if maintenanceErrorCode(t, err) != "invalid-decision" || decided ||
		result.Outcome != ConnectorSupervisorMaintenancePendingHealth {
		t.Fatalf("arbitrary decision = %#v decided=%v err=%v", result, decided, err)
	}
	if strings.Contains(err.Error(), "rm -rf") {
		t.Fatal("decision error exposed arbitrary input")
	}
}
