package selfupdate

import (
	"errors"
	"path/filepath"
	"strconv"
)

const (
	migrationPreservedState = "machine identity, protected credential, and pairing configuration"
	migrationRollback       = "restore the previous Homebrew or Project service and restart the previous connector when possible"
	migrationServiceChange  = "quiesce the known Homebrew or Project per-user connector service, prevent it from competing with the managed stable-path service, and wait for authenticated readiness from the exact target build"
)

func (service *Service) planManagedMigration(
	installation Installation,
	release Release,
	result Result,
) (Plan, error) {
	plan := Plan{
		Installation:   installation,
		MigrateManaged: true,
		Release:        release,
		Result:         result,
	}
	result = managedMigrationResult(installation, result)
	plan.Result = result

	comparison, err := compareVersions(installation.CurrentVersion, release.Manifest.Version)
	if err != nil {
		result.State = StateVerificationFailed
		result.ActionableBlocker = "The Homebrew-owned Project CLI has an invalid version; migration was refused."
		plan.Result = result
		return plan, err
	}
	if comparison > 0 {
		result.State = StateVerificationFailed
		result.ActionableBlocker = "The approved release is older than this Homebrew-owned Project CLI. Migration would downgrade Project and was refused."
		plan.Result = result
		return plan, errors.New("approved Project release would downgrade this Homebrew installation")
	}
	// Ownership migration remains actionable even when both versions match.
	result.State = StateUpdateAvailable
	result.ActionableBlocker = ""
	plan.Result = result
	return plan, nil
}

func managedMigrationResult(
	installation Installation,
	result Result,
) Result {
	result.MigrateManaged = true
	result.ManagedInstallDir = installation.InstallDir
	result.PreservedState = migrationPreservedState
	result.RollbackBehavior = migrationRollback
	result.ServiceTransition = migrationServiceChange

	if installation.Source != InstallSourceHomebrew {
		result.State = StateUnsupportedSource
		result.ActionableBlocker = "--migrate-managed is valid only for a verified Homebrew-owned Project CLI."
		return result
	}
	if (installation.Target != "darwin-arm64" && installation.Target != "linux-x64") ||
		!filepath.IsAbs(installation.InstallDir) {
		result.State = StateUnsupportedSource
		result.ActionableBlocker = "This Homebrew installation is not on a supported macOS arm64 or Linux x64/WSL host with a safe managed per-user destination."
		return result
	}
	return result
}

func recoveryCommand(executablePath string) string {
	if !filepath.IsAbs(executablePath) {
		return ""
	}
	return strconv.Quote(filepath.Clean(executablePath)) +
		" connector service start-if-connected"
}
