package selfupdate

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

type staticDetector struct {
	installation Installation
	err          error
}

func (detector staticDetector) Detect() (Installation, error) {
	return detector.installation, detector.err
}

type staticResolver struct {
	release Release
	err     error
}

func (resolver staticResolver) Resolve(context.Context, string) (Release, error) {
	return resolver.release, resolver.err
}

type staticInstaller struct {
	calls        int
	installation Installation
	outcome      ApplyOutcome
	err          error
}

func (installer *staticInstaller) Apply(
	_ context.Context,
	installation Installation,
	_ Release,
	_ io.Writer,
	_ io.Writer,
) (ApplyOutcome, error) {
	installer.calls++
	installer.installation = installation
	return installer.outcome, installer.err
}

func testRelease(version string) Release {
	return Release{
		Manifest: Manifest{Version: version},
		Artifact: Artifact{DownloadURL: "https://github.com/DotNaos/project-space/releases/download/v" + version + "/project-space-machine-tools-windows-x64-setup.exe"},
	}
}

func TestServicePlansCurrentAvailableAndUnsupportedSources(t *testing.T) {
	tests := []struct {
		name    string
		install Installation
		want    State
	}{
		{name: "current managed", install: Installation{CurrentVersion: "0.4.8", Source: InstallSourceManaged, Target: "linux-x64"}, want: StateCurrent},
		{name: "managed update", install: Installation{CurrentVersion: "0.4.7", Source: InstallSourceManaged, Target: "linux-x64"}, want: StateUpdateAvailable},
		{name: "homebrew", install: Installation{CurrentVersion: "0.4.7", Source: InstallSourceHomebrew, Target: "darwin-arm64"}, want: StateUnsupportedSource},
		{name: "same-version homebrew", install: Installation{CurrentVersion: "0.4.8", Source: InstallSourceHomebrew, Target: "darwin-arm64"}, want: StateUnsupportedSource},
		{name: "windows", install: Installation{CurrentVersion: "0.4.7", Source: InstallSourceWindows, Target: "windows-x64"}, want: StateUnsupportedSource},
		{name: "source", install: Installation{CurrentVersion: "dev", Source: InstallSourceSourceCheckout, Target: "darwin-arm64"}, want: StateUnsupportedSource},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			installer := &staticInstaller{}
			service, err := NewService(staticDetector{installation: test.install}, staticResolver{release: testRelease("0.4.8")}, installer)
			if err != nil {
				t.Fatal(err)
			}
			plan, err := service.Plan(context.Background(), PlanOptions{})
			if err != nil {
				t.Fatalf("Plan() error = %v", err)
			}
			if plan.Result.State != test.want {
				t.Fatalf("state = %q, want %q", plan.Result.State, test.want)
			}
			if plan.Result.CurrentVersion != test.install.CurrentVersion || plan.Result.TargetVersion != "0.4.8" {
				t.Fatalf("result versions = %#v", plan.Result)
			}
		})
	}
}

func TestServiceRefusesUnverifiedReleaseAndDowngrade(t *testing.T) {
	installer := &staticInstaller{}
	service, _ := NewService(
		staticDetector{installation: Installation{CurrentVersion: "0.4.8", Source: InstallSourceManaged, Target: "linux-x64"}},
		staticResolver{err: errors.New("bad signature")},
		installer,
	)
	plan, err := service.Plan(context.Background(), PlanOptions{})
	if err == nil || plan.Result.State != StateVerificationFailed || installer.calls != 0 {
		t.Fatalf("unverified plan = %#v, error = %v, calls = %d", plan, err, installer.calls)
	}

	service, _ = NewService(
		staticDetector{installation: Installation{CurrentVersion: "0.4.9", Source: InstallSourceManaged, Target: "linux-x64"}},
		staticResolver{release: testRelease("0.4.8")},
		installer,
	)
	plan, err = service.Plan(context.Background(), PlanOptions{})
	if err == nil || plan.Result.State != StateVerificationFailed || installer.calls != 0 {
		t.Fatalf("downgrade plan = %#v, error = %v, calls = %d", plan, err, installer.calls)
	}
}

func TestServicePlansSupportedHomebrewMigrationIncludingSameVersion(t *testing.T) {
	for _, currentVersion := range []string{"0.4.7", "0.4.8"} {
		t.Run(currentVersion, func(t *testing.T) {
			installation := Installation{
				CurrentVersion: "0.4.7",
				ExecutablePath: "/opt/homebrew/Cellar/project/0.4.7/bin/project",
				InstallDir:     "/Users/test/.local/bin",
				Source:         InstallSourceHomebrew,
				Target:         "darwin-arm64",
			}
			installation.CurrentVersion = currentVersion
			service, _ := NewService(
				staticDetector{installation: installation},
				staticResolver{release: testRelease("0.4.8")},
				&staticInstaller{},
			)
			plan, err := service.Plan(context.Background(), PlanOptions{
				MigrateManaged: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			if plan.Result.State != StateUpdateAvailable ||
				!plan.Result.MigrateManaged ||
				plan.Result.ManagedInstallDir != installation.InstallDir ||
				plan.Result.ServiceTransition == "" ||
				plan.Result.PreservedState == "" ||
				plan.Result.RollbackBehavior == "" {
				t.Fatalf("migration plan = %#v", plan)
			}
		})
	}
}

func TestServiceKeepsHomebrewAsTheDefaultUpdateOwner(t *testing.T) {
	service, _ := NewService(
		staticDetector{installation: Installation{
			CurrentVersion: "0.4.7",
			Source:         InstallSourceHomebrew,
			Target:         "darwin-arm64",
		}},
		staticResolver{release: testRelease("0.4.8")},
		&staticInstaller{},
	)
	plan, err := service.Plan(context.Background(), PlanOptions{})
	if err != nil ||
		plan.Result.State != StateUnsupportedSource ||
		!strings.Contains(plan.Result.ActionableBlocker, "Continue updating them with Homebrew") ||
		!strings.Contains(plan.Result.ActionableBlocker, "--migrate-managed") ||
		plan.Result.MigrateManaged {
		t.Fatalf("Homebrew plan = %#v, %v", plan, err)
	}
}

func TestServiceRejectsManagedMigrationForOtherSourcesAndPlatforms(t *testing.T) {
	tests := []Installation{
		{CurrentVersion: "0.4.7", Source: InstallSourceManaged, Target: "darwin-arm64", InstallDir: "/Users/test/.local/bin"},
		{CurrentVersion: "0.4.7", Source: InstallSourceHomebrew, Target: "", InstallDir: "/Users/test/.local/bin"},
		{CurrentVersion: "0.4.7", Source: InstallSourceHomebrew, Target: "linux-x64"},
	}
	for _, installation := range tests {
		service, _ := NewService(
			staticDetector{installation: installation},
			staticResolver{release: testRelease("0.4.8")},
			&staticInstaller{},
		)
		plan, err := service.Plan(context.Background(), PlanOptions{
			MigrateManaged: true,
		})
		if err != nil || plan.Result.State != StateUnsupportedSource {
			t.Fatalf("migration plan = %#v, error = %v", plan, err)
		}
	}
}

func TestServiceMapsInstallerOutcomes(t *testing.T) {
	tests := []struct {
		name    string
		outcome ApplyOutcome
		err     error
		want    State
		wantErr bool
	}{
		{name: "updated", outcome: ApplyOutcomeUpdated, want: StateUpdated},
		{name: "rolled back", outcome: ApplyOutcomeRolledBack, err: errors.New("exit 70"), want: StateRolledBack, wantErr: true},
		{name: "recovery required", outcome: ApplyOutcomeRecoveryRequired, err: errors.New("exit 71"), want: StateUpdateFailed, wantErr: true},
		{name: "failed", err: errors.New("exit 1"), want: StateUpdateFailed, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			installer := &staticInstaller{outcome: test.outcome, err: test.err}
			service, _ := NewService(
				staticDetector{installation: Installation{CurrentVersion: "0.4.7", Source: InstallSourceManaged}},
				staticResolver{release: testRelease("0.4.8")},
				installer,
			)
			result, err := service.Apply(context.Background(), Plan{
				Installation: Installation{CurrentVersion: "0.4.7", Source: InstallSourceManaged},
				Release:      testRelease("0.4.8"),
				Result:       Result{CurrentVersion: "0.4.7", InstallSource: InstallSourceManaged, State: StateUpdateAvailable, TargetVersion: "0.4.8"},
			}, &bytes.Buffer{}, &bytes.Buffer{})
			if result.State != test.want || (err != nil) != test.wantErr || installer.calls != 1 {
				t.Fatalf("Apply() = %#v, %v, calls %d", result, err, installer.calls)
			}
		})
	}
}

func TestServiceAppliesHomebrewMigrationAndReportsExactRecovery(t *testing.T) {
	installation := Installation{
		CurrentVersion: "0.4.8",
		ExecutablePath: "/opt/homebrew/Cellar/project/0.4.8/bin/project",
		InstallDir:     "/Users/test/.local/bin",
		Source:         InstallSourceHomebrew,
		Target:         "darwin-arm64",
	}
	installer := &staticInstaller{
		outcome: ApplyOutcomeRecoveryRequired,
		err:     errors.New("fixture recovery"),
	}
	service, _ := NewService(
		staticDetector{installation: installation},
		staticResolver{release: testRelease("0.4.8")},
		installer,
	)
	plan, err := service.Plan(context.Background(), PlanOptions{
		MigrateManaged: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Apply(
		context.Background(),
		plan,
		&bytes.Buffer{},
		&bytes.Buffer{},
	)
	if err == nil || installer.calls != 1 ||
		installer.installation.Source != InstallSourceHomebrew ||
		result.State != StateUpdateFailed ||
		result.RecoveryCommand != `"/opt/homebrew/Cellar/project/0.4.8/bin/project" connector service start-if-connected` {
		t.Fatalf("Apply() = %#v, %v, installer = %#v", result, err, installer)
	}
}

func TestCompareVersions(t *testing.T) {
	for _, test := range []struct {
		current string
		target  string
		want    int
		wantErr bool
	}{
		{current: "0.4.7", target: "0.4.8", want: -1},
		{current: "0.4.8", target: "0.4.8", want: 0},
		{current: "1.0.0", target: "0.4.8", want: 1},
		{current: "dev", target: "0.4.8", wantErr: true},
		{current: "01.0.0", target: "1.0.0", wantErr: true},
	} {
		got, err := compareVersions(test.current, test.target)
		if got != test.want || (err != nil) != test.wantErr {
			t.Errorf("compareVersions(%q, %q) = %d, %v", test.current, test.target, got, err)
		}
	}
}
