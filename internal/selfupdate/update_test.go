package selfupdate

import (
	"bytes"
	"context"
	"errors"
	"io"
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
	calls   int
	outcome ApplyOutcome
	err     error
}

func (installer *staticInstaller) Apply(
	context.Context,
	Installation,
	Release,
	io.Writer,
	io.Writer,
) (ApplyOutcome, error) {
	installer.calls++
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
			plan, err := service.Plan(context.Background())
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
	plan, err := service.Plan(context.Background())
	if err == nil || plan.Result.State != StateVerificationFailed || installer.calls != 0 {
		t.Fatalf("unverified plan = %#v, error = %v, calls = %d", plan, err, installer.calls)
	}

	service, _ = NewService(
		staticDetector{installation: Installation{CurrentVersion: "0.4.9", Source: InstallSourceManaged, Target: "linux-x64"}},
		staticResolver{release: testRelease("0.4.8")},
		installer,
	)
	plan, err = service.Plan(context.Background())
	if err == nil || plan.Result.State != StateVerificationFailed || installer.calls != 0 {
		t.Fatalf("downgrade plan = %#v, error = %v, calls = %d", plan, err, installer.calls)
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
