package machineconnect

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	ConnectorSupervisorControlSchema          = "project-space.connector-runtime-supervisor-control/v1"
	ConnectorSupervisorDecisionSchema         = "project-space.connector-runtime-supervisor-decision/v1"
	ConnectorSupervisorMaintenanceStateSchema = "project-space.connector-runtime-supervisor-state/v1"

	ConnectorSupervisorMaintenanceControlEnv     = "PROJECT_CONNECTOR_RUNTIME_CONTROL_FILE"
	ConnectorSupervisorMaintenanceDecisionEnv    = "PROJECT_CONNECTOR_RUNTIME_DECISION_FILE"
	ConnectorSupervisorMaintenanceStagingEnv     = "PROJECT_CONNECTOR_RUNTIME_STAGING_DIR"
	ConnectorSupervisorMaintenanceOperationIDEnv = "PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID"
	ConnectorSupervisorMaintenanceStateEnv       = "PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE"
	ConnectorReleaseSigningKeyFileEnv            = "PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_FILE"
	ConnectorRuntimeInstallSourceEnv             = "PROJECT_SPACE_INSTALL_SOURCE"

	connectorSupervisorMaintenanceDirectoryName = "maintenance"
	connectorSupervisorControlFileName          = "control.json"
	connectorSupervisorDecisionFileName         = "decision.json"
	connectorSupervisorStateFileName            = "state.json"
	connectorSupervisorStagingDirectoryName     = "staging"
	connectorSupervisorVersionsDirectoryName    = "versions"
	connectorSupervisorCurrentPointerName       = "current"
	connectorSupervisorCommandKeyFileName       = "connector-command-signing-public-key.pem"
	connectorSupervisorReleaseKeyFileName       = "release-manifest-signing-public-key.pem"

	defaultConnectorSupervisorHealthTimeout   = 2 * time.Minute
	defaultConnectorSupervisorDecisionPoll    = 250 * time.Millisecond
	defaultConnectorSupervisorMaxArtifact     = int64(2 * 1024 * 1024 * 1024)
	defaultConnectorSupervisorMaxExtracted    = int64(4 * 1024 * 1024 * 1024)
	maximumConnectorSupervisorControlBytes    = 512 * 1024
	maximumConnectorSupervisorDecisionBytes   = 64 * 1024
	maximumConnectorSupervisorStateBytes      = 64 * 1024
	maximumConnectorSupervisorArchiveMembers  = 64
	maximumConnectorSupervisorCapabilityCount = 64
)

type ConnectorSupervisorMaintenanceOperation string

const (
	ConnectorSupervisorMaintenanceRestart ConnectorSupervisorMaintenanceOperation = "restart"
	ConnectorSupervisorMaintenanceUpdate  ConnectorSupervisorMaintenanceOperation = "update"
)

type ConnectorSupervisorMaintenanceOutcome string

const (
	ConnectorSupervisorMaintenanceNone             ConnectorSupervisorMaintenanceOutcome = "none"
	ConnectorSupervisorMaintenanceRestartRequested ConnectorSupervisorMaintenanceOutcome = "restart-requested"
	ConnectorSupervisorMaintenancePendingHealth    ConnectorSupervisorMaintenanceOutcome = "pending-health-check"
	ConnectorSupervisorMaintenanceSucceeded        ConnectorSupervisorMaintenanceOutcome = "succeeded"
	ConnectorSupervisorMaintenanceRolledBack       ConnectorSupervisorMaintenanceOutcome = "rolled-back"
	ConnectorSupervisorMaintenanceFailed           ConnectorSupervisorMaintenanceOutcome = "failed"
	ConnectorSupervisorMaintenanceRecoveryRequired ConnectorSupervisorMaintenanceOutcome = "recovery-required"
)

type ConnectorSupervisorMaintenanceEvidenceState string

const (
	ConnectorSupervisorEvidencePending    ConnectorSupervisorMaintenanceEvidenceState = "pending-health-check"
	ConnectorSupervisorEvidenceRolledBack ConnectorSupervisorMaintenanceEvidenceState = "rolled-back"
)

type ConnectorSupervisorBundleVersions struct {
	Connector    string `json:"connector"`
	MachineTools string `json:"machineTools"`
	ProjectCLI   string `json:"projectCli"`
}

type ConnectorSupervisorRuntimeFingerprint struct {
	BuildID         string                            `json:"buildId"`
	BundleVersions  ConnectorSupervisorBundleVersions `json:"bundleVersions"`
	Capabilities    []string                          `json:"capabilities"`
	InstanceID      string                            `json:"instanceId"`
	ProtocolVersion string                            `json:"protocolVersion"`
	ReleaseID       string                            `json:"releaseId"`
	Version         string                            `json:"version"`
}

type ConnectorSupervisorMaintenanceEvidence struct {
	OperationID string                                      `json:"operationId"`
	State       ConnectorSupervisorMaintenanceEvidenceState `json:"state"`
}

type ConnectorSupervisorMaintenanceResult struct {
	Evidence        *ConnectorSupervisorMaintenanceEvidence
	Operation       ConnectorSupervisorMaintenanceOperation
	OperationID     string
	Outcome         ConnectorSupervisorMaintenanceOutcome
	RestartRequired bool
}

type ConnectorSupervisorMaintenancePaths struct {
	ControlFile     string
	CurrentPointer  string
	DecisionFile    string
	MaintenanceRoot string
	StagingRoot     string
	StateFile       string
	ToolsRoot       string
	VersionsRoot    string
}

type ConnectorSupervisorMaintenanceOptions struct {
	CommandVerificationKeyFile string
	ExpectedMachineID          string
	HealthTimeout              time.Duration
	MaximumArtifact            int64
	MaximumExtracted           int64
	Now                        func() time.Time
	PollInterval               time.Duration
	ReleaseVerificationKeyFile string
	Target                     string
	ToolsRoot                  string
}

type ConnectorSupervisorMaintenance struct {
	commandVerificationKeyFile string
	expectedMachineID          string
	healthTimeout              time.Duration
	maximumArtifact            int64
	maximumExtracted           int64
	now                        func() time.Time
	paths                      ConnectorSupervisorMaintenancePaths
	pollInterval               time.Duration
	releaseVerificationKeyFile string
	target                     string

	// Tests use these hooks to model process death at durable transition edges.
	afterPointerSwitch  func() error
	beforePointerSwitch func() error
}

type ConnectorSupervisorMaintenanceError struct {
	Code string
	err  error
}

func (err *ConnectorSupervisorMaintenanceError) Error() string {
	return "connector supervisor maintenance failed: " + err.Code
}

func (err *ConnectorSupervisorMaintenanceError) Unwrap() error { return err.err }

func maintenanceError(code string, err error) error {
	return &ConnectorSupervisorMaintenanceError{Code: code, err: err}
}

func NewConnectorSupervisorMaintenance(
	options ConnectorSupervisorMaintenanceOptions,
) (*ConnectorSupervisorMaintenance, error) {
	toolsRoot := strings.TrimSpace(options.ToolsRoot)
	if toolsRoot != options.ToolsRoot || toolsRoot == "" ||
		strings.ContainsRune(toolsRoot, '\x00') || !filepath.IsAbs(toolsRoot) {
		return nil, errors.New("connector supervisor maintenance tools root is invalid")
	}
	toolsRoot = filepath.Clean(toolsRoot)
	commandKeyFile, err := validConnectorSupervisorPublicKeyPath(
		options.CommandVerificationKeyFile,
		"command",
	)
	if err != nil {
		return nil, err
	}
	if !connectorSupervisorMachineIDPattern.MatchString(options.ExpectedMachineID) {
		return nil, errors.New("connector supervisor maintenance machine ID is invalid")
	}
	releaseKeyFile, err := validConnectorSupervisorPublicKeyPath(
		options.ReleaseVerificationKeyFile,
		"release",
	)
	if err != nil {
		return nil, err
	}
	commandKey, err := readConnectorSupervisorPublicKey(commandKeyFile)
	if err != nil {
		return nil, errors.New("connector supervisor command verification key is unavailable")
	}
	releaseKey, err := readConnectorSupervisorPublicKey(releaseKeyFile)
	if err != nil {
		return nil, errors.New("connector supervisor release verification key is unavailable")
	}
	if string(commandKey) == string(releaseKey) {
		return nil, errors.New("connector supervisor release verification key must be dedicated")
	}
	if !validConnectorSupervisorTarget(options.Target) {
		return nil, errors.New("connector supervisor maintenance target is invalid")
	}
	healthTimeout := options.HealthTimeout
	if healthTimeout == 0 {
		healthTimeout = defaultConnectorSupervisorHealthTimeout
	}
	if healthTimeout < time.Second || healthTimeout > 30*time.Minute {
		return nil, errors.New("connector supervisor maintenance health timeout is invalid")
	}
	pollInterval := options.PollInterval
	if pollInterval == 0 {
		pollInterval = defaultConnectorSupervisorDecisionPoll
	}
	if pollInterval < 10*time.Millisecond || pollInterval > 5*time.Second {
		return nil, errors.New("connector supervisor maintenance poll interval is invalid")
	}
	maximumArtifact := options.MaximumArtifact
	if maximumArtifact == 0 {
		maximumArtifact = defaultConnectorSupervisorMaxArtifact
	}
	maximumExtracted := options.MaximumExtracted
	if maximumExtracted == 0 {
		maximumExtracted = defaultConnectorSupervisorMaxExtracted
	}
	if maximumArtifact < 1 || maximumArtifact > defaultConnectorSupervisorMaxArtifact ||
		maximumExtracted < maximumArtifact ||
		maximumExtracted > defaultConnectorSupervisorMaxExtracted {
		return nil, errors.New("connector supervisor maintenance size limit is invalid")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	maintenanceRoot := filepath.Join(toolsRoot, connectorSupervisorMaintenanceDirectoryName)
	return &ConnectorSupervisorMaintenance{
		commandVerificationKeyFile: commandKeyFile,
		expectedMachineID:          options.ExpectedMachineID,
		healthTimeout:              healthTimeout,
		maximumArtifact:            maximumArtifact,
		maximumExtracted:           maximumExtracted,
		now:                        now,
		paths: ConnectorSupervisorMaintenancePaths{
			ControlFile:     filepath.Join(maintenanceRoot, connectorSupervisorControlFileName),
			CurrentPointer:  filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName),
			DecisionFile:    filepath.Join(maintenanceRoot, connectorSupervisorDecisionFileName),
			MaintenanceRoot: maintenanceRoot,
			StagingRoot:     filepath.Join(maintenanceRoot, connectorSupervisorStagingDirectoryName),
			StateFile:       filepath.Join(maintenanceRoot, connectorSupervisorStateFileName),
			ToolsRoot:       toolsRoot,
			VersionsRoot:    filepath.Join(toolsRoot, connectorSupervisorVersionsDirectoryName),
		},
		pollInterval:               pollInterval,
		releaseVerificationKeyFile: releaseKeyFile,
		target:                     options.Target,
	}, nil
}

func ConnectorSupervisorMaintenanceTarget(goos, goarch string) (string, error) {
	switch goos + "/" + goarch {
	case "darwin/arm64":
		return "darwin-arm64", nil
	case "linux/amd64":
		return "linux-x64", nil
	case "windows/amd64":
		return "windows-x64", nil
	default:
		return "", fmt.Errorf("connector supervisor maintenance is unsupported on %s/%s", goos, goarch)
	}
}

func CurrentConnectorSupervisorMaintenanceTarget() (string, error) {
	return ConnectorSupervisorMaintenanceTarget(runtime.GOOS, runtime.GOARCH)
}

// ResolveConnectorSupervisorMaintenanceToolsRoot accepts either a managed
// Project CLI symlink or a binary inside one managed release. Legacy flat
// installs intentionally fail so an old connector cannot claim self-update.
func ResolveConnectorSupervisorMaintenanceToolsRoot(executable string) (string, error) {
	if strings.TrimSpace(executable) != executable || executable == "" ||
		strings.ContainsRune(executable, '\x00') || !filepath.IsAbs(executable) {
		return "", errors.New("managed connector executable path is invalid")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(executable))
	if err != nil {
		return "", fmt.Errorf("resolve managed connector executable: %w", err)
	}
	versionDirectory := filepath.Dir(resolved)
	versionsRoot := filepath.Dir(versionDirectory)
	toolsRoot := filepath.Dir(versionsRoot)
	if filepath.Base(versionsRoot) != connectorSupervisorVersionsDirectoryName ||
		filepath.Base(toolsRoot) != ".project-space-machine-tools" ||
		!managedPointerComponentPattern.MatchString(filepath.Base(versionDirectory)) {
		return "", errors.New("connector is not running from a managed release")
	}
	current, err := readManagedPointer(
		filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName),
		versionsRoot,
	)
	if err != nil || filepath.Base(current) != filepath.Base(versionDirectory) {
		return "", errors.New("connector executable does not match the managed current release")
	}
	return toolsRoot, nil
}

func (maintenance *ConnectorSupervisorMaintenance) Paths() ConnectorSupervisorMaintenancePaths {
	return maintenance.paths
}

func (maintenance *ConnectorSupervisorMaintenance) CompanionEnvironment(
	evidence *ConnectorSupervisorMaintenanceEvidence,
) ([]string, error) {
	environment := []string{
		ConnectorSupervisorMaintenanceControlEnv + "=" + maintenance.paths.ControlFile,
		ConnectorSupervisorMaintenanceDecisionEnv + "=" + maintenance.paths.DecisionFile,
		ConnectorSupervisorMaintenanceStagingEnv + "=" + maintenance.paths.StagingRoot,
		ConnectorCommandSigningKeyFileEnv + "=" + maintenance.commandVerificationKeyFile,
		ConnectorReleaseSigningKeyFileEnv + "=" + maintenance.releaseVerificationKeyFile,
		ConnectorRuntimeInstallSourceEnv + "=managed",
	}
	if evidence == nil {
		return environment, nil
	}
	if !validConnectorSupervisorIdentifier(evidence.OperationID, 256) ||
		(evidence.State != ConnectorSupervisorEvidencePending &&
			evidence.State != ConnectorSupervisorEvidenceRolledBack) {
		return nil, errors.New("connector supervisor maintenance evidence is invalid")
	}
	return append(
		environment,
		ConnectorSupervisorMaintenanceOperationIDEnv+"="+evidence.OperationID,
		ConnectorSupervisorMaintenanceStateEnv+"="+string(evidence.State),
	), nil
}

func validConnectorSupervisorPublicKeyPath(value, name string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed != value || trimmed == "" || strings.ContainsRune(trimmed, '\x00') ||
		!filepath.IsAbs(trimmed) {
		return "", fmt.Errorf("connector supervisor %s verification key path is invalid", name)
	}
	return filepath.Clean(trimmed), nil
}

func (maintenance *ConnectorSupervisorMaintenance) WaitForHealthDecision(
	ctx context.Context,
) (ConnectorSupervisorMaintenanceResult, error) {
	if ctx == nil {
		return ConnectorSupervisorMaintenanceResult{}, errors.New("connector maintenance context is missing")
	}
	for {
		result, decided, err := maintenance.CheckHealthDecision()
		if err != nil {
			var typed *ConnectorSupervisorMaintenanceError
			if !errors.As(err, &typed) ||
				(typed.Code != "invalid-decision" && typed.Code != "stale-decision") {
				return result, err
			}
		} else if decided {
			return result, err
		}
		timer := time.NewTimer(maintenance.pollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ConnectorSupervisorMaintenanceResult{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func validConnectorSupervisorTarget(target string) bool {
	return target == "darwin-arm64" || target == "linux-x64" || target == "windows-x64"
}

func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
