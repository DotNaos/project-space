package machineconnect

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

const (
	maintenanceTestOldPointer = "versions/0.4.0-oldbuild000000"
	maintenanceTestOperation  = "operation-191"
	maintenanceTestVersion    = "1.2.3"
)

var maintenanceTestNow = time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)

type maintenanceTestFixture struct {
	commandPrivate ed25519.PrivateKey
	maintenance    *ConnectorSupervisorMaintenance
	releasePrivate ed25519.PrivateKey
	root           string
	target         string
	t              *testing.T
}

func newMaintenanceTestFixture(t *testing.T, target string) *maintenanceTestFixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("managed connector maintenance is unsupported on Windows")
	}
	root := filepath.Join(t.TempDir(), ".project-space-machine-tools")
	mustMkdir(t, root)
	versions := filepath.Join(root, connectorSupervisorVersionsDirectoryName)
	mustMkdir(t, versions)
	mustMkdir(t, filepath.Join(versions, filepath.Base(maintenanceTestOldPointer)))
	if err := os.Symlink(maintenanceTestOldPointer, filepath.Join(root, "current")); err != nil {
		t.Fatal(err)
	}
	keyRoot := filepath.Join(root, "keys")
	mustMkdir(t, keyRoot)
	commandPublic, commandPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	releasePublic, releasePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	commandKeyPath := filepath.Join(keyRoot, "command.pem")
	releaseKeyPath := filepath.Join(keyRoot, "release.pem")
	writeMaintenanceTestPublicKey(t, commandKeyPath, commandPublic)
	writeMaintenanceTestPublicKey(t, releaseKeyPath, releasePublic)
	maintenance, err := NewConnectorSupervisorMaintenance(ConnectorSupervisorMaintenanceOptions{
		CommandVerificationKeyFile: commandKeyPath,
		ExpectedMachineID:          "machine-191",
		HealthTimeout:              time.Minute,
		MaximumArtifact:            16 * 1024 * 1024,
		MaximumExtracted:           32 * 1024 * 1024,
		Now:                        func() time.Time { return maintenanceTestNow },
		ReleaseVerificationKeyFile: releaseKeyPath,
		Target:                     target,
		ToolsRoot:                  root,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := maintenance.ensureDirectories(); err != nil {
		t.Fatal(err)
	}
	return &maintenanceTestFixture{
		commandPrivate: commandPrivate,
		maintenance:    maintenance,
		releasePrivate: releasePrivate,
		root:           root,
		target:         target,
		t:              t,
	}
}

func writeMaintenanceTestPublicKey(t *testing.T, path string, key ed25519.PublicKey) {
	t.Helper()
	body := maintenanceTestPublicKeyPEM(t, key)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func maintenanceTestPublicKeyPEM(t *testing.T, key ed25519.PublicKey) []byte {
	t.Helper()
	encoded, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: encoded})
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func (fixture *maintenanceTestFixture) pointer() string {
	fixture.t.Helper()
	target, err := os.Readlink(fixture.maintenance.paths.CurrentPointer)
	if err != nil {
		fixture.t.Fatal(err)
	}
	return target
}

func maintenanceTestFingerprint() ConnectorSupervisorRuntimeFingerprint {
	return ConnectorSupervisorRuntimeFingerprint{
		BuildID: "a4c3b2d1e0f9a8b7c6d5e4f32100112233445566",
		BundleVersions: ConnectorSupervisorBundleVersions{
			Connector: "0.4.0", MachineTools: "0.4.0", ProjectCLI: "0.4.0",
		},
		Capabilities:    []string{"runtime.restart", "runtime.update"},
		InstanceID:      "old-instance",
		ProtocolVersion: "2",
		ReleaseID:       "v0.4.0",
		Version:         "0.4.0",
	}
}

func (fixture *maintenanceTestFixture) writeRestartControl(operationID string) {
	fixture.t.Helper()
	plan := connectorSupervisorRestartPlan{
		MachineID:       "machine-191",
		Operation:       "restart",
		OperationID:     operationID,
		PreviousRuntime: maintenanceTestFingerprint(),
		Schema:          connectorRuntimeCommandSchema,
		Target:          fixture.target,
	}
	fixture.writeControl(plan, nil)
}

func (fixture *maintenanceTestFixture) writeUpdateControl(
	operationID string,
	archive []byte,
) string {
	fixture.t.Helper()
	assetName := fmt.Sprintf(
		"project-space-machine-tools-%s-v%s.tar.gz",
		fixture.target,
		maintenanceTestVersion,
	)
	if fixture.target == "windows-x64" {
		assetName = "project-space-machine-tools-windows-x64-setup.exe"
	}
	digest := sha256.Sum256(archive)
	digestString := hex.EncodeToString(digest[:])
	artifact := connectorSupervisorReleaseArtifact{
		AssetName: assetName,
		BundleVersions: ConnectorSupervisorBundleVersions{
			Connector: maintenanceTestVersion, MachineTools: maintenanceTestVersion,
			ProjectCLI: maintenanceTestVersion,
		},
		Capabilities:    []string{"runtime.restart", "runtime.update"},
		DownloadURL:     "https://github.com/DotNaos/project-space/releases/download/v1.2.3/" + assetName,
		ProtocolVersion: "2",
		SHA256:          digestString,
		SizeBytes:       int64(len(archive)),
		Target:          fixture.target,
	}
	release := connectorSupervisorSignedRelease{
		Manifest: connectorSupervisorReleaseManifest{
			Artifacts: []connectorSupervisorReleaseArtifact{artifact},
			BuildID:   "0123456789abcdef0123456789abcdef01234567",
			Channel:   "stable",
			ExpiresAt: "2027-07-14T10:00:00.000Z",
			IssuedAt:  "2026-07-14T10:00:00.000Z",
			ReleaseID: "v1.2.3",
			Schema:    connectorRuntimeReleaseSchema,
			Source:    "managed",
			Version:   maintenanceTestVersion,
		},
	}
	manifestBody, err := json.Marshal(release.Manifest)
	if err != nil {
		fixture.t.Fatal(err)
	}
	canonicalManifest, err := canonicalConnectorSupervisorJSON(manifestBody)
	if err != nil {
		fixture.t.Fatal(err)
	}
	release.Signature = base64.RawURLEncoding.EncodeToString(
		ed25519.Sign(fixture.releasePrivate, canonicalManifest),
	)
	plan := connectorSupervisorUpdatePlan{
		MachineID:       "machine-191",
		Operation:       "update",
		OperationID:     operationID,
		PreviousRuntime: maintenanceTestFingerprint(),
		Release:         release,
		ReleaseID:       "v1.2.3",
		Schema:          connectorRuntimeCommandSchema,
		Target:          fixture.target,
	}
	operationHash := sha256.Sum256([]byte(operationID))
	path := filepath.Join(
		fixture.maintenance.paths.StagingRoot,
		fmt.Sprintf("runtime-%s-%s", hex.EncodeToString(operationHash[:])[:24], assetName),
	)
	if err := os.WriteFile(path, archive, 0o600); err != nil {
		fixture.t.Fatal(err)
	}
	fixture.writeControl(plan, &connectorSupervisorControlArtifact{
		Path: path, SHA256: digestString, SizeBytes: int64(len(archive)),
	})
	return path
}

func (fixture *maintenanceTestFixture) writeControl(plan any, artifact *connectorSupervisorControlArtifact) {
	fixture.t.Helper()
	planBody, err := json.Marshal(plan)
	if err != nil {
		fixture.t.Fatal(err)
	}
	planDigest, err := connectorSupervisorRawDigest(planBody)
	if err != nil {
		fixture.t.Fatal(err)
	}
	var planFields map[string]json.RawMessage
	if err := json.Unmarshal(planBody, &planFields); err != nil {
		fixture.t.Fatal(err)
	}
	previousDigest, err := connectorSupervisorRawDigest(planFields["previousRuntime"])
	if err != nil {
		fixture.t.Fatal(err)
	}
	operation := string(planFields["operation"])
	operation = strings.Trim(operation, `"`)
	operationID := strings.Trim(string(planFields["operationId"]), `"`)
	target := strings.Trim(string(planFields["target"]), `"`)
	grant := connectorSupervisorControlGrant{
		ExpiresAt:             "2026-07-14T10:00:30.000Z",
		Generation:            7,
		IssuedAt:              "2026-07-14T10:00:00.000Z",
		MachineID:             "machine-191",
		Nonce:                 "nonce-191",
		Operation:             operation,
		OperationID:           operationID,
		PlanSHA256:            planDigest,
		PreviousRuntimeSHA256: previousDigest,
		Target:                target,
		UserID:                "user-191",
	}
	grant.Signature = base64.RawURLEncoding.EncodeToString(
		ed25519.Sign(fixture.commandPrivate, canonicalConnectorSupervisorGrant(grant)),
	)
	control := connectorSupervisorRawControl{
		Artifact: artifact,
		Command: connectorSupervisorRawCommand{
			Grant: grant,
			Plan:  planBody,
		},
		Schema: ConnectorSupervisorControlSchema,
	}
	body, err := json.Marshal(control)
	if err != nil {
		fixture.t.Fatal(err)
	}
	if err := os.WriteFile(fixture.maintenance.paths.ControlFile, append(body, '\n'), 0o600); err != nil {
		fixture.t.Fatal(err)
	}
}

func (fixture *maintenanceTestFixture) readRawControl() connectorSupervisorRawControl {
	fixture.t.Helper()
	body, err := os.ReadFile(fixture.maintenance.paths.ControlFile)
	if err != nil {
		fixture.t.Fatal(err)
	}
	var control connectorSupervisorRawControl
	if err := decodeConnectorSupervisorJSON(body, &control); err != nil {
		fixture.t.Fatal(err)
	}
	return control
}

func (fixture *maintenanceTestFixture) writeRawControl(control connectorSupervisorRawControl) {
	fixture.t.Helper()
	control.Command.Grant.Signature = base64.RawURLEncoding.EncodeToString(
		ed25519.Sign(
			fixture.commandPrivate,
			canonicalConnectorSupervisorGrant(control.Command.Grant),
		),
	)
	body, err := json.Marshal(control)
	if err != nil {
		fixture.t.Fatal(err)
	}
	if err := os.WriteFile(
		fixture.maintenance.paths.ControlFile,
		append(body, '\n'),
		0o600,
	); err != nil {
		fixture.t.Fatal(err)
	}
}

func (fixture *maintenanceTestFixture) resignRelease(
	release *connectorSupervisorSignedRelease,
) {
	fixture.t.Helper()
	body, err := json.Marshal(release.Manifest)
	if err != nil {
		fixture.t.Fatal(err)
	}
	canonical, err := canonicalConnectorSupervisorJSON(body)
	if err != nil {
		fixture.t.Fatal(err)
	}
	release.Signature = base64.RawURLEncoding.EncodeToString(
		ed25519.Sign(fixture.releasePrivate, canonical),
	)
}

func (fixture *maintenanceTestFixture) writeDecision(operationID, action string) {
	fixture.t.Helper()
	if err := writeConnectorSupervisorPrivateJSON(
		fixture.maintenance.paths.DecisionFile,
		connectorSupervisorDecision{
			Action: action, OperationID: operationID, Schema: ConnectorSupervisorDecisionSchema,
		},
	); err != nil {
		fixture.t.Fatal(err)
	}
}

func maintenanceTestArchive(t *testing.T, target string) []byte {
	t.Helper()
	commandPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	releasePublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return maintenanceTestArchiveWithKeys(t, target, commandPublic, releasePublic)
}

func maintenanceTestArchiveWithKeys(
	t *testing.T,
	target string,
	commandPublic ed25519.PublicKey,
	releasePublic ed25519.PublicKey,
) []byte {
	return maintenanceTestArchiveWithKeysAndCodex(
		t,
		target,
		commandPublic,
		releasePublic,
		target == "linux-x64",
	)
}

func maintenanceTestArchiveWithKeysAndCodex(
	t *testing.T,
	target string,
	commandPublic ed25519.PublicKey,
	releasePublic ed25519.PublicKey,
	includeCodex bool,
) []byte {
	t.Helper()
	members := map[string][]byte{
		"project":                             []byte("project-binary"),
		"project-space-connector":             []byte("connector-binary"),
		"install.sh":                          []byte("#!/bin/sh\nexit 0\n"),
		"VERSION":                             []byte(maintenanceTestVersion + "\n"),
		connectorSupervisorCommandKeyFileName: maintenanceTestPublicKeyPEM(t, commandPublic),
		connectorSupervisorReleaseKeyFileName: maintenanceTestPublicKeyPEM(t, releasePublic),
	}
	if target == "darwin-arm64" {
		members["project-approval-signer"] = []byte("signer-binary")
	}
	if target == "linux-x64" && includeCodex {
		members["codex"] = []byte("codex-binary")
		members["CODEX-LICENSE"] = []byte("codex-license")
		members["CODEX-NOTICE"] = []byte("codex-notice")
		members["CODEX-VERSION"] = []byte("0.145.0\n")
	}
	names := make([]string, 0, len(members))
	for name := range members {
		names = append(names, name)
	}
	sort.Strings(names)
	var checksums strings.Builder
	for _, name := range names {
		digest := sha256.Sum256(members[name])
		fmt.Fprintf(&checksums, "%s  %s\n", hex.EncodeToString(digest[:]), name)
	}
	members["SHA256SUMS.txt"] = []byte(checksums.String())
	root := fmt.Sprintf("project-space-machine-tools-%s-v%s", target, maintenanceTestVersion)
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{Name: root + "/", Typeflag: tar.TypeDir, Mode: 0o755}); err != nil {
		t.Fatal(err)
	}
	allNames := make([]string, 0, len(members))
	for name := range members {
		allNames = append(allNames, name)
	}
	sort.Strings(allNames)
	for _, name := range allNames {
		body := members[name]
		mode := int64(0o644)
		if name == "project" || name == "project-space-connector" || name == "codex" ||
			name == "project-approval-signer" || name == "install.sh" {
			mode = 0o755
		}
		if err := tarWriter.WriteHeader(&tar.Header{
			Name: root + "/" + name, Mode: mode, Size: int64(len(body)), Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func maintenanceMaliciousArchive(t *testing.T, name string, typeFlag byte) []byte {
	t.Helper()
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	tarWriter := tar.NewWriter(gzipWriter)
	header := &tar.Header{Name: name, Mode: 0o755, Size: 1, Typeflag: typeFlag}
	if typeFlag == tar.TypeSymlink {
		header.Size = 0
		header.Linkname = "/tmp/escape"
	}
	if err := tarWriter.WriteHeader(header); err != nil {
		t.Fatal(err)
	}
	if header.Size > 0 {
		_, _ = io.WriteString(tarWriter, "x")
	}
	_ = tarWriter.Close()
	_ = gzipWriter.Close()
	return output.Bytes()
}

func maintenanceErrorCode(t *testing.T, err error) string {
	t.Helper()
	var typed *ConnectorSupervisorMaintenanceError
	if !errors.As(err, &typed) {
		t.Fatalf("error = %v, want ConnectorSupervisorMaintenanceError", err)
	}
	return typed.Code
}

func assertMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("path %s exists or errored: %v", path, err)
	}
}
