package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type Service struct {
	detector  InstallDetector
	installer ArtifactInstaller
	releases  ReleaseResolver
}

func NewService(
	detector InstallDetector,
	releases ReleaseResolver,
	installer ArtifactInstaller,
) (*Service, error) {
	if detector == nil || releases == nil || installer == nil {
		return nil, errors.New("self-update dependencies are incomplete")
	}
	return &Service{detector: detector, releases: releases, installer: installer}, nil
}

func (service *Service) Plan(ctx context.Context, options PlanOptions) (Plan, error) {
	installation, err := service.detector.Detect()
	if err != nil {
		result := Result{
			InstallSource: InstallSourceUnknown,
			State:         StateVerificationFailed,
			ActionableBlocker: "The current Project installation could not be verified. " +
				"Reinstall an approved machine-tools release.",
		}
		return Plan{Result: result}, fmt.Errorf("detect Project installation: %w", err)
	}
	result := Result{
		CurrentVersion: installation.CurrentVersion,
		InstallSource:  installation.Source,
		State:          StateVerificationFailed,
	}
	if options.MigrateManaged {
		result = managedMigrationResult(installation, result)
		if result.State == StateUnsupportedSource {
			return Plan{
				Installation:   installation,
				MigrateManaged: true,
				Result:         result,
			}, nil
		}
	}
	release, err := service.releases.Resolve(ctx, installation.Target)
	if err != nil {
		result.ActionableBlocker = "The approved Project release could not be verified. Try again later; no files were changed."
		return Plan{
			Installation:   installation,
			MigrateManaged: options.MigrateManaged,
			Result:         result,
		}, fmt.Errorf("verify approved Project release: %w", err)
	}
	result.TargetVersion = release.Manifest.Version
	if options.MigrateManaged {
		return service.planManagedMigration(installation, release, result)
	}
	comparison, err := compareVersions(installation.CurrentVersion, release.Manifest.Version)
	if err != nil {
		if installation.Source == InstallSourceManaged {
			result.ActionableBlocker = "The managed installation has an invalid current version. Reinstall an approved machine-tools release."
			return Plan{Installation: installation, Release: release, Result: result}, err
		}
		result.State = StateUnsupportedSource
		result.ActionableBlocker = unsupportedSourceGuidance(installation.Source, release.Artifact.DownloadURL)
		return Plan{Installation: installation, Release: release, Result: result}, nil
	}
	if comparison > 0 {
		result.ActionableBlocker = "The approved release is older than this Project CLI. Downgrades are refused."
		return Plan{Installation: installation, Release: release, Result: result}, errors.New("approved Project release would downgrade this installation")
	}
	if installation.Source != InstallSourceManaged {
		result.State = StateUnsupportedSource
		result.ActionableBlocker = unsupportedSourceGuidance(installation.Source, release.Artifact.DownloadURL)
		return Plan{Installation: installation, Release: release, Result: result}, nil
	}
	if comparison == 0 {
		result.State = StateCurrent
		return Plan{Installation: installation, Release: release, Result: result}, nil
	}
	result.State = StateUpdateAvailable
	return Plan{Installation: installation, Release: release, Result: result}, nil
}

func (service *Service) Apply(
	ctx context.Context,
	plan Plan,
	stdout io.Writer,
	stderr io.Writer,
) (Result, error) {
	result := plan.Result
	applicableManagedUpdate := plan.Installation.Source == InstallSourceManaged &&
		!plan.MigrateManaged
	applicableMigration := plan.Installation.Source == InstallSourceHomebrew &&
		plan.MigrateManaged
	if result.State != StateUpdateAvailable ||
		(!applicableManagedUpdate && !applicableMigration) {
		return result, errors.New("self-update plan is not applicable")
	}
	outcome, err := service.installer.Apply(
		ctx,
		plan.Installation,
		plan.Release,
		stdout,
		stderr,
	)
	switch outcome {
	case ApplyOutcomeUpdated:
		if err != nil {
			result.State = StateUpdateFailed
			result.ActionableBlocker = "The new release was installed but could not be verified. Run project doctor before retrying."
			return result, err
		}
		result.State = StateUpdated
		result.ActionableBlocker = ""
		return result, nil
	case ApplyOutcomeRolledBack:
		result.State = StateRolledBack
		result.ActionableBlocker = "The update failed and the previous matching CLI and connector release was restored."
		if err == nil {
			err = errors.New("self-update rolled back")
		}
		return result, err
	case ApplyOutcomeRecoveryRequired:
		result.State = StateUpdateFailed
		result.ActionableBlocker = "Rollback could not restore the previous connector service. Machine identity and credentials were retained; run the recovery command locally."
		result.RecoveryCommand = recoveryCommand(plan.Installation.ExecutablePath)
		if err == nil {
			err = errors.New("self-update requires manual recovery")
		}
		return result, err
	default:
		result.State = StateUpdateFailed
		result.ActionableBlocker = "The update failed before a verified release switch completed."
		if err == nil {
			err = errors.New("self-update failed")
		}
		return result, err
	}
}

func unsupportedSourceGuidance(source InstallSource, installerURL string) string {
	switch source {
	case InstallSourceHomebrew:
		return "Homebrew owns this Project CLI and connector. Continue updating them with Homebrew, or run `project self-update --migrate-managed` to plan an optional signed managed migration; Project will not overwrite Homebrew files."
	case InstallSourceWindows:
		return "Native Windows cannot safely replace the running project.exe in place. Download and run the verified per-user installer: " + installerURL
	case InstallSourceSourceCheckout:
		return "This Project CLI was built from source. Pull the checkout and rebuild it; self-update never overwrites development binaries."
	default:
		return "This installation source cannot be updated in place. Reinstall the approved machine-tools release from " + installerURL
	}
}

func compareVersions(current, target string) (int, error) {
	currentParts, err := stableVersionParts(current)
	if err != nil {
		return 0, fmt.Errorf("invalid current Project version %q", current)
	}
	targetParts, err := stableVersionParts(target)
	if err != nil {
		return 0, fmt.Errorf("invalid target Project version %q", target)
	}
	for index := range currentParts {
		if currentParts[index] < targetParts[index] {
			return -1, nil
		}
		if currentParts[index] > targetParts[index] {
			return 1, nil
		}
	}
	return 0, nil
}

func stableVersionParts(value string) ([3]uint64, error) {
	var result [3]uint64
	parts := strings.Split(value, ".")
	if len(parts) != len(result) {
		return result, errors.New("version must have three numeric components")
	}
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return result, errors.New("version component is not canonical")
		}
		number, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return result, errors.New("version component is invalid")
		}
		result[index] = number
	}
	return result, nil
}
