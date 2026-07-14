package machineconnect

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

type connectorSupervisorControlArtifact struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
}

type connectorSupervisorControlGrant struct {
	ExpiresAt             string `json:"expiresAt"`
	Generation            int64  `json:"generation"`
	IssuedAt              string `json:"issuedAt"`
	MachineID             string `json:"machineId"`
	Nonce                 string `json:"nonce"`
	Operation             string `json:"operation"`
	OperationID           string `json:"operationId"`
	PlanSHA256            string `json:"planSha256"`
	PreviousRuntimeSHA256 string `json:"previousRuntimeSha256"`
	Signature             string `json:"signature"`
	Target                string `json:"target"`
	UserID                string `json:"userId"`
}

type connectorSupervisorRawCommand struct {
	Grant connectorSupervisorControlGrant `json:"grant"`
	Plan  json.RawMessage                 `json:"plan"`
}

type connectorSupervisorRawControl struct {
	Artifact *connectorSupervisorControlArtifact `json:"artifact,omitempty"`
	Command  connectorSupervisorRawCommand       `json:"command"`
	Schema   string                              `json:"schema"`
}

type connectorSupervisorRestartPlan struct {
	MachineID       string                                `json:"machineId"`
	Operation       string                                `json:"operation"`
	OperationID     string                                `json:"operationId"`
	PreviousRuntime ConnectorSupervisorRuntimeFingerprint `json:"previousRuntime"`
	Schema          string                                `json:"schema"`
	Target          string                                `json:"target"`
}

type connectorSupervisorUpdatePlan struct {
	MachineID       string                                `json:"machineId"`
	Operation       string                                `json:"operation"`
	OperationID     string                                `json:"operationId"`
	PreviousRuntime ConnectorSupervisorRuntimeFingerprint `json:"previousRuntime"`
	Release         connectorSupervisorSignedRelease      `json:"release"`
	ReleaseID       string                                `json:"releaseId"`
	Schema          string                                `json:"schema"`
	Target          string                                `json:"target"`
}

type connectorSupervisorReleaseArtifact struct {
	AssetName       string                            `json:"assetName"`
	BundleVersions  ConnectorSupervisorBundleVersions `json:"bundleVersions"`
	Capabilities    []string                          `json:"capabilities"`
	DownloadURL     string                            `json:"downloadUrl"`
	ProtocolVersion string                            `json:"protocolVersion"`
	SHA256          string                            `json:"sha256"`
	SizeBytes       int64                             `json:"sizeBytes"`
	Target          string                            `json:"target"`
}

type connectorSupervisorReleaseManifest struct {
	Artifacts []connectorSupervisorReleaseArtifact `json:"artifacts"`
	BuildID   string                               `json:"buildId"`
	Channel   string                               `json:"channel"`
	ExpiresAt string                               `json:"expiresAt"`
	IssuedAt  string                               `json:"issuedAt"`
	ReleaseID string                               `json:"releaseId"`
	Schema    string                               `json:"schema"`
	Source    string                               `json:"source"`
	Version   string                               `json:"version"`
}

type connectorSupervisorSignedRelease struct {
	Manifest  connectorSupervisorReleaseManifest `json:"manifest"`
	Signature string                             `json:"signature"`
}

type connectorSupervisorControlRequest struct {
	Artifact        *connectorSupervisorControlArtifact
	ExpectedRuntime ConnectorSupervisorRuntimeFingerprint
	Operation       ConnectorSupervisorMaintenanceOperation
	OperationID     string
	PreviousRuntime ConnectorSupervisorRuntimeFingerprint
	ReleaseID       string
	Target          string
	Version         string
}

const connectorRuntimeCommandSchema = "project-space.connector-runtime-command/v1"
const connectorRuntimeReleaseSchema = "project-space.connector-runtime-release/v1"

const (
	connectorSupervisorCommandClockSkew   = 5 * time.Second
	connectorSupervisorReleaseClockSkew   = 5 * time.Minute
	connectorSupervisorReleaseMaxLifetime = 370 * 24 * time.Hour
)

var (
	connectorSupervisorIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,255}$`)
	connectorSupervisorMachineIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:\-]{0,255}$`)
	connectorSupervisorDigestPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	connectorSupervisorBuildIDPattern    = regexp.MustCompile(`^[0-9a-f]{40}$`)
	connectorSupervisorAssetNamePattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+\-]{0,191}$`)
	connectorSupervisorCapabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9.\-]{0,127}$`)
	connectorSupervisorProtocolPattern   = regexp.MustCompile(`^[1-9][0-9]{0,7}$`)
	connectorSupervisorSemanticVersion   = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
	connectorSupervisorTimestampPattern  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	connectorSupervisorReleaseIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$`)
)

func (maintenance *ConnectorSupervisorMaintenance) readControl() (
	connectorSupervisorControlRequest,
	error,
) {
	body, err := readConnectorSupervisorPrivateFile(
		maintenance.paths.ControlFile,
		maximumConnectorSupervisorControlBytes,
	)
	if err != nil {
		return connectorSupervisorControlRequest{}, err
	}
	var raw connectorSupervisorRawControl
	if err := decodeConnectorSupervisorJSON(body, &raw); err != nil {
		return connectorSupervisorControlRequest{}, err
	}
	if raw.Schema != ConnectorSupervisorControlSchema {
		return connectorSupervisorControlRequest{}, errors.New("supervisor control schema is unsupported")
	}
	return maintenance.parseControlCommand(raw)
}

func (maintenance *ConnectorSupervisorMaintenance) parseControlCommand(
	raw connectorSupervisorRawControl,
) (connectorSupervisorControlRequest, error) {
	grant := raw.Command.Grant
	if err := maintenance.validateConnectorSupervisorGrant(grant); err != nil {
		return connectorSupervisorControlRequest{}, err
	}
	if err := maintenance.verifyCommandGrant(grant); err != nil {
		return connectorSupervisorControlRequest{}, err
	}
	planDigest, err := connectorSupervisorRawDigest(raw.Command.Plan)
	if err != nil || planDigest != grant.PlanSHA256 {
		return connectorSupervisorControlRequest{}, errors.New("supervisor control plan digest is invalid")
	}
	var planFields map[string]json.RawMessage
	if err := json.Unmarshal(raw.Command.Plan, &planFields); err != nil {
		return connectorSupervisorControlRequest{}, errors.New("supervisor control plan is invalid")
	}
	previousRaw := planFields["previousRuntime"]
	previousDigest, err := connectorSupervisorRawDigest(previousRaw)
	if err != nil || previousDigest != grant.PreviousRuntimeSHA256 {
		return connectorSupervisorControlRequest{}, errors.New("supervisor control runtime digest is invalid")
	}

	switch grant.Operation {
	case string(ConnectorSupervisorMaintenanceRestart):
		if raw.Artifact != nil {
			return connectorSupervisorControlRequest{}, errors.New("restart control must not contain an artifact")
		}
		var plan connectorSupervisorRestartPlan
		if err := decodeConnectorSupervisorJSON(raw.Command.Plan, &plan); err != nil {
			return connectorSupervisorControlRequest{}, err
		}
		if err := validateConnectorSupervisorPlanBinding(
			grant, plan.MachineID, plan.Operation, plan.OperationID, plan.Schema, plan.Target,
			plan.PreviousRuntime,
		); err != nil {
			return connectorSupervisorControlRequest{}, err
		}
		expected := cloneConnectorSupervisorFingerprint(plan.PreviousRuntime)
		expected.InstanceID = ""
		return connectorSupervisorControlRequest{
			ExpectedRuntime: expected,
			Operation:       ConnectorSupervisorMaintenanceRestart,
			OperationID:     plan.OperationID,
			PreviousRuntime: cloneConnectorSupervisorFingerprint(plan.PreviousRuntime),
			Target:          plan.Target,
		}, nil
	case string(ConnectorSupervisorMaintenanceUpdate):
		if raw.Artifact == nil {
			return connectorSupervisorControlRequest{}, errors.New("update control artifact is missing")
		}
		var plan connectorSupervisorUpdatePlan
		if err := decodeConnectorSupervisorJSON(raw.Command.Plan, &plan); err != nil {
			return connectorSupervisorControlRequest{}, err
		}
		if err := validateConnectorSupervisorPlanBinding(
			grant, plan.MachineID, plan.Operation, plan.OperationID, plan.Schema, plan.Target,
			plan.PreviousRuntime,
		); err != nil {
			return connectorSupervisorControlRequest{}, err
		}
		artifact, err := maintenance.validateRelease(plan)
		if err != nil {
			return connectorSupervisorControlRequest{}, err
		}
		if err := maintenance.validateStagedArtifact(
			*raw.Artifact,
			artifact,
			plan.OperationID,
		); err != nil {
			return connectorSupervisorControlRequest{}, err
		}
		return connectorSupervisorControlRequest{
			Artifact: raw.Artifact,
			ExpectedRuntime: ConnectorSupervisorRuntimeFingerprint{
				BuildID:         plan.Release.Manifest.BuildID,
				BundleVersions:  artifact.BundleVersions,
				Capabilities:    append([]string(nil), artifact.Capabilities...),
				ProtocolVersion: artifact.ProtocolVersion,
				ReleaseID:       plan.Release.Manifest.ReleaseID,
				Version:         plan.Release.Manifest.Version,
			},
			Operation:       ConnectorSupervisorMaintenanceUpdate,
			OperationID:     plan.OperationID,
			PreviousRuntime: cloneConnectorSupervisorFingerprint(plan.PreviousRuntime),
			ReleaseID:       plan.ReleaseID,
			Target:          plan.Target,
			Version:         plan.Release.Manifest.Version,
		}, nil
	default:
		return connectorSupervisorControlRequest{}, errors.New("supervisor control operation is unsupported")
	}
}

func (maintenance *ConnectorSupervisorMaintenance) validateConnectorSupervisorGrant(
	grant connectorSupervisorControlGrant,
) error {
	issuedAt, issuedErr := parseConnectorSupervisorTimestamp(grant.IssuedAt)
	expiresAt, expiresErr := parseConnectorSupervisorTimestamp(grant.ExpiresAt)
	signature, signatureErr := decodeConnectorSupervisorSignature(grant.Signature)
	now := maintenance.now().UTC()
	if grant.MachineID != maintenance.expectedMachineID ||
		!connectorSupervisorMachineIDPattern.MatchString(grant.MachineID) ||
		!validConnectorSupervisorIdentifier(grant.UserID, 256) ||
		!validConnectorSupervisorIdentifier(grant.Nonce, 256) ||
		!validConnectorSupervisorIdentifier(grant.OperationID, 256) ||
		(grant.Operation != string(ConnectorSupervisorMaintenanceRestart) &&
			grant.Operation != string(ConnectorSupervisorMaintenanceUpdate)) ||
		!validConnectorSupervisorTarget(grant.Target) || grant.Generation < 1 ||
		!connectorSupervisorDigestPattern.MatchString(grant.PlanSHA256) ||
		!connectorSupervisorDigestPattern.MatchString(grant.PreviousRuntimeSHA256) ||
		signatureErr != nil || len(signature) != 64 || issuedErr != nil || expiresErr != nil ||
		!expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > time.Minute ||
		issuedAt.After(now.Add(connectorSupervisorCommandClockSkew)) ||
		expiresAt.Before(now.Add(-connectorSupervisorCommandClockSkew)) {
		return errors.New("supervisor control grant is invalid")
	}
	return nil
}

func validateConnectorSupervisorPlanBinding(
	grant connectorSupervisorControlGrant,
	machineID, operation, operationID, schema, target string,
	previous ConnectorSupervisorRuntimeFingerprint,
) error {
	if schema != connectorRuntimeCommandSchema || machineID != grant.MachineID ||
		operation != grant.Operation || operationID != grant.OperationID || target != grant.Target ||
		!validConnectorSupervisorFingerprint(previous, false) {
		return errors.New("supervisor control plan binding is invalid")
	}
	return nil
}

func (maintenance *ConnectorSupervisorMaintenance) validateRelease(
	plan connectorSupervisorUpdatePlan,
) (connectorSupervisorReleaseArtifact, error) {
	manifest := plan.Release.Manifest
	if err := maintenance.verifyReleaseSignature(plan.Release); err != nil {
		return connectorSupervisorReleaseArtifact{}, err
	}
	signature, signatureErr := decodeConnectorSupervisorSignature(plan.Release.Signature)
	issuedAt, issuedErr := parseConnectorSupervisorTimestamp(manifest.IssuedAt)
	expiresAt, expiresErr := parseConnectorSupervisorTimestamp(manifest.ExpiresAt)
	now := maintenance.now().UTC()
	if manifest.Schema != connectorRuntimeReleaseSchema || manifest.Source != "managed" ||
		(manifest.Channel != "stable" && manifest.Channel != "beta") ||
		!connectorSupervisorBuildIDPattern.MatchString(manifest.BuildID) ||
		!connectorSupervisorReleaseIDPattern.MatchString(manifest.ReleaseID) ||
		strings.EqualFold(manifest.ReleaseID, "latest") || manifest.ReleaseID != plan.ReleaseID ||
		manifest.ReleaseID != "v"+manifest.Version ||
		!connectorSupervisorSemanticVersion.MatchString(manifest.Version) ||
		signatureErr != nil || len(signature) != 64 || issuedErr != nil || expiresErr != nil ||
		!expiresAt.After(issuedAt) ||
		expiresAt.Sub(issuedAt) > connectorSupervisorReleaseMaxLifetime ||
		issuedAt.After(now.Add(connectorSupervisorReleaseClockSkew)) ||
		!expiresAt.After(now) ||
		len(manifest.Artifacts) < 1 || len(manifest.Artifacts) > 3 {
		return connectorSupervisorReleaseArtifact{}, errors.New("supervisor release manifest is invalid")
	}
	seen := map[string]struct{}{}
	var selected *connectorSupervisorReleaseArtifact
	for index := range manifest.Artifacts {
		artifact := &manifest.Artifacts[index]
		if _, duplicate := seen[artifact.Target]; duplicate {
			return connectorSupervisorReleaseArtifact{}, errors.New("supervisor release target is duplicated")
		}
		seen[artifact.Target] = struct{}{}
		if err := validateConnectorSupervisorReleaseArtifact(*artifact, manifest); err != nil {
			return connectorSupervisorReleaseArtifact{}, err
		}
		if artifact.Target == plan.Target {
			copy := *artifact
			selected = &copy
		}
	}
	if selected == nil {
		return connectorSupervisorReleaseArtifact{}, errors.New("supervisor release does not support the target")
	}
	return *selected, nil
}

func validateConnectorSupervisorReleaseArtifact(
	artifact connectorSupervisorReleaseArtifact,
	manifest connectorSupervisorReleaseManifest,
) error {
	expectedName := fmt.Sprintf(
		"project-space-machine-tools-%s-v%s.tar.gz",
		artifact.Target,
		manifest.Version,
	)
	if artifact.Target == "windows-x64" {
		expectedName = "project-space-machine-tools-windows-x64-setup.exe"
	}
	expectedURL := fmt.Sprintf(
		"https://github.com/DotNaos/project-space/releases/download/%s/%s",
		manifest.ReleaseID,
		expectedName,
	)
	if !validConnectorSupervisorTarget(artifact.Target) ||
		!connectorSupervisorAssetNamePattern.MatchString(artifact.AssetName) ||
		artifact.AssetName != expectedName || artifact.DownloadURL != expectedURL ||
		!validConnectorSupervisorBundleVersions(artifact.BundleVersions) ||
		!validConnectorSupervisorCapabilities(artifact.Capabilities) ||
		!connectorSupervisorProtocolPattern.MatchString(artifact.ProtocolVersion) ||
		!connectorSupervisorDigestPattern.MatchString(artifact.SHA256) ||
		artifact.SizeBytes < 1 || artifact.SizeBytes > defaultConnectorSupervisorMaxArtifact {
		return errors.New("supervisor release artifact is invalid")
	}
	return nil
}

func (maintenance *ConnectorSupervisorMaintenance) validateStagedArtifact(
	staged connectorSupervisorControlArtifact,
	release connectorSupervisorReleaseArtifact,
	operationID string,
) error {
	operationHash := sha256.Sum256([]byte(operationID))
	expectedName := fmt.Sprintf(
		"runtime-%s-%s",
		hex.EncodeToString(operationHash[:])[:24],
		release.AssetName,
	)
	if !filepath.IsAbs(staged.Path) || filepath.Clean(staged.Path) != staged.Path ||
		filepath.Dir(staged.Path) != maintenance.paths.StagingRoot ||
		filepath.Base(staged.Path) != expectedName || staged.SHA256 != release.SHA256 ||
		staged.SizeBytes != release.SizeBytes || staged.SizeBytes > maintenance.maximumArtifact {
		return errors.New("supervisor staged artifact is invalid")
	}
	return nil
}

func connectorSupervisorRawDigest(raw []byte) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("canonical value is missing")
	}
	canonical, err := canonicalConnectorSupervisorJSON(raw)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func parseConnectorSupervisorTimestamp(value string) (time.Time, error) {
	if !connectorSupervisorTimestampPattern.MatchString(value) {
		return time.Time{}, errors.New("timestamp is not canonical")
	}
	return time.Parse("2006-01-02T15:04:05.000Z", value)
}

func validConnectorSupervisorIdentifier(value string, maximum int) bool {
	return len(value) > 0 && len(value) <= maximum &&
		connectorSupervisorIdentifierPattern.MatchString(value)
}

func validConnectorSupervisorBundleVersions(value ConnectorSupervisorBundleVersions) bool {
	return connectorSupervisorSemanticVersion.MatchString(value.Connector) &&
		connectorSupervisorSemanticVersion.MatchString(value.MachineTools) &&
		connectorSupervisorSemanticVersion.MatchString(value.ProjectCLI)
}

func validConnectorSupervisorCapabilities(capabilities []string) bool {
	if len(capabilities) > maximumConnectorSupervisorCapabilityCount {
		return false
	}
	for index, capability := range capabilities {
		if !connectorSupervisorCapabilityPattern.MatchString(capability) ||
			(index > 0 && capabilities[index-1] >= capability) {
			return false
		}
	}
	return true
}

func validConnectorSupervisorFingerprint(
	fingerprint ConnectorSupervisorRuntimeFingerprint,
	allowEmptyInstance bool,
) bool {
	instanceValid := validConnectorSupervisorIdentifier(fingerprint.InstanceID, 128)
	if allowEmptyInstance && fingerprint.InstanceID == "" {
		instanceValid = true
	}
	return len(fingerprint.BuildID) > 0 && len(fingerprint.BuildID) <= 128 &&
		validConnectorSupervisorBundleVersions(fingerprint.BundleVersions) &&
		validConnectorSupervisorCapabilities(fingerprint.Capabilities) && instanceValid &&
		connectorSupervisorProtocolPattern.MatchString(fingerprint.ProtocolVersion) &&
		connectorSupervisorReleaseIDPattern.MatchString(fingerprint.ReleaseID) &&
		connectorSupervisorSemanticVersion.MatchString(fingerprint.Version)
}

func cloneConnectorSupervisorFingerprint(
	fingerprint ConnectorSupervisorRuntimeFingerprint,
) ConnectorSupervisorRuntimeFingerprint {
	fingerprint.Capabilities = slices.Clone(fingerprint.Capabilities)
	return fingerprint
}
