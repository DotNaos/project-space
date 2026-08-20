package selfupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
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

func testDarwinRelease(t *testing.T, archive []byte, version string) Release {
	t.Helper()
	digest := sha256.Sum256(archive)
	return Release{
		Artifact: Artifact{
			AssetName: "project-space-machine-tools-darwin-arm64-v" + version + ".tar.gz",
			BundleVersions: BundleVersions{
				Connector:    version,
				MachineTools: version,
				ProjectCLI:   version,
			},
			DownloadURL: "https://github.com/DotNaos/project-space/releases/download/v" + version + "/project-space-machine-tools-darwin-arm64-v" + version + ".tar.gz",
			SHA256:      hex.EncodeToString(digest[:]),
			SizeBytes:   int64(len(archive)),
			Target:      "darwin-arm64",
		},
		Manifest: Manifest{ReleaseID: "v" + version, Version: version},
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

func TestServiceAppliesManagedDarwinUpgradeFromOlderSupportedInstallation(t *testing.T) {
	const previousVersion = "0.21.23"
	installDir := writeManagedInstallationFixture(t, previousVersion, "0.21.23-0123456789abcdef")
	archive := testArtifactArchive(t, "darwin-arm64", "0.27.0", nil)
	release := testDarwinRelease(t, archive, "0.27.0")
	var calls []string
	installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
		Client:             &http.Client{Transport: testArtifactTransport(archive)},
		CommandRunner:      managedFixtureCommandRunner(t, &calls, false),
		HomeDirectory:      "/safe/home",
		TemporaryDirectory: t.TempDir(),
	})
	service, err := NewService(
		NewInstallDetector(InstallDetectorOptions{
			CurrentVersion: previousVersion,
			ExecutablePath: filepath.Join(installDir, "project"),
			GOARCH:         "arm64",
			GOOS:           "darwin",
		}),
		staticResolver{release: release},
		installer,
	)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := service.Plan(context.Background())
	if err != nil || plan.Result.State != StateUpdateAvailable {
		t.Fatalf("Plan() = %#v, %v", plan.Result, err)
	}
	if plan.Installation.CurrentVersion != previousVersion || plan.Installation.Source != InstallSourceManaged {
		t.Fatalf("Plan() did not detect the installed prior release: %#v", plan.Installation)
	}
	previousCurrent := readManagedCurrentTarget(t, installDir)
	result, err := service.Apply(context.Background(), plan, io.Discard, io.Discard)
	if err != nil || result.State != StateUpdated {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	if len(calls) != 3 || calls[0] != "install.sh" || calls[1] != "project" || calls[2] != "project-codex-host" {
		t.Fatalf("calls = %#v, want install.sh, project, project-codex-host", calls)
	}
	if previousCurrent != "versions/0.21.23-0123456789abcdef" {
		t.Fatalf("previous current target = %q", previousCurrent)
	}
	if current := readManagedCurrentTarget(t, installDir); current != "versions/0.27.0-fedcba9876543210" {
		t.Fatalf("current target after upgrade = %q", current)
	}
	if got := readManagedVersion(t, installDir); got != "0.27.0" {
		t.Fatalf("active version after upgrade = %q", got)
	}
	if got := readManagedVersionAt(t, installDir, "0.21.23-0123456789abcdef"); got != previousVersion {
		t.Fatalf("retained prior release version = %q", got)
	}
}

func TestServiceKeepsOlderManagedInstallationWhenDarwinUpgradeRollsBack(t *testing.T) {
	const previousVersion = "0.21.23"
	installDir := writeManagedInstallationFixture(t, previousVersion, "0.21.23-0123456789abcdef")
	archive := testArtifactArchive(t, "darwin-arm64", "0.27.0", nil)
	release := testDarwinRelease(t, archive, "0.27.0")
	var calls []string
	installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
		Client:             &http.Client{Transport: testArtifactTransport(archive)},
		CommandRunner:      managedFixtureCommandRunner(t, &calls, true),
		HomeDirectory:      "/safe/home",
		TemporaryDirectory: t.TempDir(),
	})
	service, err := NewService(
		NewInstallDetector(InstallDetectorOptions{
			CurrentVersion: previousVersion,
			ExecutablePath: filepath.Join(installDir, "project"),
			GOARCH:         "arm64",
			GOOS:           "darwin",
		}),
		staticResolver{release: release},
		installer,
	)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := service.Plan(context.Background())
	if err != nil || plan.Result.State != StateUpdateAvailable {
		t.Fatalf("Plan() = %#v, %v", plan.Result, err)
	}
	previousCurrent := readManagedCurrentTarget(t, installDir)
	result, err := service.Apply(context.Background(), plan, io.Discard, io.Discard)
	if err == nil || result.State != StateRolledBack {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	if len(calls) != 1 || calls[0] != "install.sh" {
		t.Fatalf("calls = %#v, want only the rollback-capable installer", calls)
	}
	if current := readManagedCurrentTarget(t, installDir); current != previousCurrent {
		t.Fatalf("current target after rollback = %q, want %q", current, previousCurrent)
	}
	if got := readManagedVersion(t, installDir); got != previousVersion {
		t.Fatalf("active version after rollback = %q", got)
	}
	if got := readManagedVersionAt(t, installDir, "0.21.23-0123456789abcdef"); got != previousVersion {
		t.Fatalf("retained prior release version = %q", got)
	}
}

func writeManagedInstallationFixture(t *testing.T, version, releaseID string) string {
	t.Helper()
	installDir := t.TempDir()
	releaseDir := filepath.Join(installDir, managedToolsDirectory, "versions", releaseID)
	if err := os.MkdirAll(releaseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFixtureExecutable(t, filepath.Join(releaseDir, "project"), "project "+version)
	writeFixtureExecutable(t, filepath.Join(releaseDir, "project-codex-host"), "project-codex-host "+version)
	if err := os.WriteFile(filepath.Join(releaseDir, "VERSION"), []byte(version+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(releaseDir, "release-manifest-signing-public-key.pem"), []byte("fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, "versions/"+releaseID, filepath.Join(installDir, managedToolsDirectory, "current"))
	mustSymlink(t, ".project-space-machine-tools/current/project", filepath.Join(installDir, "project"))
	mustSymlink(t, ".project-space-machine-tools/current/project-codex-host", filepath.Join(installDir, "project-codex-host"))
	return installDir
}

func managedFixtureCommandRunner(t *testing.T, calls *[]string, failAfterSwitch bool) ArtifactCommandRunner {
	t.Helper()
	return func(
		_ context.Context,
		command string,
		arguments []string,
		_ string,
		_ []string,
		stdout io.Writer,
		_ io.Writer,
	) error {
		name := filepath.Base(command)
		*calls = append(*calls, name)
		if name != "install.sh" {
			installDir := filepath.Dir(command)
			_, err := io.WriteString(stdout, "Project "+readManagedVersion(t, installDir)+"\n")
			return err
		}
		if len(arguments) != 2 || arguments[0] != "--install-dir" {
			t.Fatalf("installer arguments = %#v", arguments)
		}
		installDir := arguments[1]
		const candidateVersion = "0.27.0"
		const candidateReleaseID = candidateVersion + "-fedcba9876543210"
		candidateDir := filepath.Join(installDir, managedToolsDirectory, "versions", candidateReleaseID)
		if err := os.MkdirAll(candidateDir, 0o700); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"project", "project-codex-host", "VERSION", "release-manifest-signing-public-key.pem"} {
			body, err := os.ReadFile(filepath.Join(commandDirectory(command), name))
			if err != nil {
				t.Fatal(err)
			}
			mode := os.FileMode(0o600)
			if name == "project" || name == "project-codex-host" {
				mode = 0o700
			}
			if err := os.WriteFile(filepath.Join(candidateDir, name), body, mode); err != nil {
				t.Fatal(err)
			}
		}
		currentLink := filepath.Join(installDir, managedToolsDirectory, "current")
		previousTarget, err := os.Readlink(currentLink)
		if err != nil {
			t.Fatal(err)
		}
		nextLink := filepath.Join(installDir, managedToolsDirectory, ".current.next")
		if err := os.Symlink("versions/"+candidateReleaseID, nextLink); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(nextLink, currentLink); err != nil {
			t.Fatal(err)
		}
		if failAfterSwitch {
			rollbackLink := filepath.Join(installDir, managedToolsDirectory, ".current.rollback")
			if err := os.Symlink(previousTarget, rollbackLink); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(rollbackLink, currentLink); err != nil {
				t.Fatal(err)
			}
			return artifactExitError(70)
		}
		return nil
	}
}

func commandDirectory(command string) string {
	return filepath.Dir(command)
}

func writeFixtureExecutable(t *testing.T, path, output string) {
	t.Helper()
	body := "#!/bin/sh\nprintf '%s\\n' '" + output + "'\n"
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
}

func readManagedCurrentTarget(t *testing.T, installDir string) string {
	t.Helper()
	target, err := os.Readlink(filepath.Join(installDir, managedToolsDirectory, "current"))
	if err != nil {
		t.Fatal(err)
	}
	return target
}

func readManagedVersion(t *testing.T, installDir string) string {
	t.Helper()
	return readManagedVersionAt(t, installDir, filepath.Base(readManagedCurrentTarget(t, installDir)))
}

func readManagedVersionAt(t *testing.T, installDir, releaseID string) string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(installDir, managedToolsDirectory, "versions", releaseID, "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(body))
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
