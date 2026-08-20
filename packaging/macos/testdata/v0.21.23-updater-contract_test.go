package selfupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

const legacyInstalledVersion = "0.21.23"

type legacyArchiveRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip legacyArchiveRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestV02123DarwinUpdaterAgainstCurrentPackage(t *testing.T) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("the real candidate installer requires macOS arm64")
	}
	version := requiredEnvironment(t, "PROJECT_CANDIDATE_VERSION")
	candidate := readArchive(t, "PROJECT_CANDIDATE_ARCHIVE")
	publishedShape := readArchive(t, "PROJECT_V0272_SHAPE_ARCHIVE")

	t.Run("accepts candidate and atomically switches", func(t *testing.T) {
		fixture := newLegacyInstallation(t)
		outcome, err, calls := applyLegacyArchive(t, fixture, candidate, version, false)
		if err != nil || outcome != ApplyOutcomeUpdated {
			t.Fatalf("v0.21.23 Apply() = %q, %v", outcome, err)
		}
		if want := []string{"install.sh", "project", "project-codex-host"}; !reflect.DeepEqual(calls, want) {
			t.Fatalf("command calls = %#v, want %#v", calls, want)
		}
		current := readCurrentTarget(t, fixture.installDirectory)
		if current == fixture.previousCurrent || !strings.HasPrefix(current, "versions/"+version+"-") {
			t.Fatalf("current target after update = %q, previous %q", current, fixture.previousCurrent)
		}
		assertVersion(t, filepath.Join(fixture.installDirectory, managedToolsDirectory, "current"), version)
		assertVersion(t, fixture.previousRelease, legacyInstalledVersion)
		if _, err := os.Stat(filepath.Join(fixture.installDirectory, managedToolsDirectory, "current", "codex")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("legacy Codex marker was installed: %v", err)
		}
	})

	t.Run("rejects published v0.27.2 shape before installer", func(t *testing.T) {
		fixture := newLegacyInstallation(t)
		outcome, err, calls := applyLegacyArchive(t, fixture, publishedShape, version, false)
		if err == nil || outcome != "" || !strings.Contains(err.Error(), "release artifact bundle is incomplete") {
			t.Fatalf("v0.21.23 Apply() = %q, %v", outcome, err)
		}
		if len(calls) != 0 {
			t.Fatalf("incomplete archive invoked commands: %#v", calls)
		}
		if current := readCurrentTarget(t, fixture.installDirectory); current != fixture.previousCurrent {
			t.Fatalf("current target after rejection = %q, want %q", current, fixture.previousCurrent)
		}
		assertVersion(t, fixture.previousRelease, legacyInstalledVersion)
	})

	t.Run("failed candidate rolls back to prior release", func(t *testing.T) {
		fixture := newLegacyInstallation(t)
		outcome, err, calls := applyLegacyArchive(t, fixture, candidate, version, true)
		if err == nil || outcome != ApplyOutcomeRolledBack {
			t.Fatalf("v0.21.23 Apply() = %q, %v", outcome, err)
		}
		if want := []string{"install.sh"}; !reflect.DeepEqual(calls, want) {
			t.Fatalf("rollback command calls = %#v, want %#v", calls, want)
		}
		if current := readCurrentTarget(t, fixture.installDirectory); current != fixture.previousCurrent {
			t.Fatalf("current target after rollback = %q, want %q", current, fixture.previousCurrent)
		}
		assertVersion(t, filepath.Join(fixture.installDirectory, managedToolsDirectory, "current"), legacyInstalledVersion)
		assertVersion(t, fixture.previousRelease, legacyInstalledVersion)
	})
}

type legacyInstallationFixture struct {
	homeDirectory    string
	installDirectory string
	previousCurrent  string
	previousRelease  string
	fakeBinaryPath   string
}

func newLegacyInstallation(t *testing.T) legacyInstallationFixture {
	t.Helper()
	homeDirectory := t.TempDir()
	installDirectory := filepath.Join(homeDirectory, ".local", "bin")
	previousID := "0.21.23-48a5e5cbadc3e1eb"
	previousCurrent := "versions/" + previousID
	previousRelease := filepath.Join(installDirectory, managedToolsDirectory, "versions", previousID)
	if err := os.MkdirAll(previousRelease, 0o700); err != nil {
		t.Fatal(err)
	}
	writeLegacyExecutable(t, filepath.Join(previousRelease, "project"), "project", "legacy project")
	writeLegacyExecutable(t, filepath.Join(previousRelease, "project-codex-host"), "project-codex-host", "legacy codex host")
	if err := os.WriteFile(filepath.Join(previousRelease, "VERSION"), []byte(legacyInstalledVersion+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(previousRelease, "release-manifest-signing-public-key.pem"),
		[]byte("legacy fixture trust root\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(previousCurrent, filepath.Join(installDirectory, managedToolsDirectory, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(
		filepath.Join(managedToolsDirectory, "current", "project"),
		filepath.Join(installDirectory, "project"),
	); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(
		filepath.Join(managedToolsDirectory, "current", "project-codex-host"),
		filepath.Join(installDirectory, "project-codex-host"),
	); err != nil {
		t.Fatal(err)
	}
	fakeBinaryPath := filepath.Join(homeDirectory, "fake-bin")
	if err := os.Mkdir(fakeBinaryPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fakeBinaryPath, "launchctl"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return legacyInstallationFixture{
		homeDirectory:    homeDirectory,
		installDirectory: installDirectory,
		previousCurrent:  previousCurrent,
		previousRelease:  previousRelease,
		fakeBinaryPath:   fakeBinaryPath,
	}
}

func applyLegacyArchive(
	t *testing.T,
	fixture legacyInstallationFixture,
	archive []byte,
	version string,
	forceInstallerFailure bool,
) (ApplyOutcome, error, []string) {
	t.Helper()
	digest := sha256.Sum256(archive)
	assetName := "project-space-machine-tools-darwin-arm64-v" + version + ".tar.gz"
	downloadURL := "https://github.com/DotNaos/project-space/releases/download/v" + version + "/" + assetName
	var calls []string
	runner := func(
		ctx context.Context,
		command string,
		arguments []string,
		directory string,
		environment []string,
		stdout io.Writer,
		stderr io.Writer,
	) error {
		calls = append(calls, filepath.Base(command))
		environment = isolatedCommandEnvironment(environment, fixture.fakeBinaryPath)
		if filepath.Base(command) == "install.sh" {
			assertExtractedCodexMarker(t, ctx, directory, environment)
			if forceInstallerFailure {
				environment = append(environment, "PROJECT_FIXTURE_CODEX_HOST_VERSION=0.4.7")
			}
		}
		process := exec.CommandContext(ctx, command, arguments...)
		process.Dir = directory
		process.Env = environment
		process.Stdout = stdout
		process.Stderr = stderr
		return process.Run()
	}
	installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
		Client: &http.Client{Transport: legacyArchiveRoundTripper(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				Body:          io.NopCloser(bytes.NewReader(archive)),
				ContentLength: int64(len(archive)),
				Header:        make(http.Header),
				Request:       request,
				StatusCode:    http.StatusOK,
			}, nil
		})},
		CommandRunner:      runner,
		HomeDirectory:      fixture.homeDirectory,
		TemporaryDirectory: t.TempDir(),
	})
	var output bytes.Buffer
	outcome, err := installer.Apply(
		context.Background(),
		Installation{
			CurrentVersion: legacyInstalledVersion,
			ExecutablePath: filepath.Join(fixture.installDirectory, "project"),
			InstallDir:     fixture.installDirectory,
			Source:         InstallSourceManaged,
			Target:         "darwin-arm64",
		},
		Release{
			Artifact: Artifact{
				AssetName:   assetName,
				DownloadURL: downloadURL,
				SHA256:      hex.EncodeToString(digest[:]),
				SizeBytes:   int64(len(archive)),
				Target:      "darwin-arm64",
			},
			Manifest: Manifest{ReleaseID: "v" + version, Version: version},
		},
		&output,
		&output,
	)
	if err != nil {
		t.Logf("v0.21.23 updater output: %s", strings.TrimSpace(output.String()))
	}
	return outcome, err, calls
}

func assertExtractedCodexMarker(t *testing.T, ctx context.Context, directory string, environment []string) {
	t.Helper()
	marker := filepath.Join(directory, "codex")
	info, err := os.Stat(marker)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("extracted legacy Codex marker mode = %v, %v", info, err)
	}
	process := exec.CommandContext(ctx, marker)
	process.Dir = directory
	process.Env = environment
	var stderr bytes.Buffer
	process.Stderr = &stderr
	err = process.Run()
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() != 69 ||
		!strings.Contains(stderr.String(), "standalone Codex runtime is not shipped") {
		t.Fatalf("legacy Codex marker = %v, stderr %q", err, stderr.String())
	}
}

func isolatedCommandEnvironment(environment []string, fakeBinaryPath string) []string {
	result := append([]string(nil), environment...)
	path := "PATH=" + strings.Join([]string{fakeBinaryPath, "/usr/bin", "/bin"}, string(os.PathListSeparator))
	for index, value := range result {
		if strings.HasPrefix(value, "PATH=") {
			result[index] = path
			return result
		}
	}
	return append(result, path)
}

func requiredEnvironment(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%s is required", name)
	}
	return value
}

func readArchive(t *testing.T, environmentName string) []byte {
	t.Helper()
	path := requiredEnvironment(t, environmentName)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func writeLegacyExecutable(t *testing.T, path, name, label string) {
	t.Helper()
	body := fmt.Sprintf(`#!/bin/bash
if [[ "${1:-}" == --version ]]; then
  printf '%%s\n' '%s %s'
  exit 0
fi
printf '%%s\n' '%s'
`, name, legacyInstalledVersion, label)
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
}

func readCurrentTarget(t *testing.T, installDirectory string) string {
	t.Helper()
	target, err := os.Readlink(filepath.Join(installDirectory, managedToolsDirectory, "current"))
	if err != nil {
		t.Fatal(err)
	}
	return target
}

func assertVersion(t *testing.T, releaseDirectory, want string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(releaseDirectory, "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(body)); got != want {
		t.Fatalf("release version = %q, want %q", got, want)
	}
}
