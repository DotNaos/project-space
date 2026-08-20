package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type artifactRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip artifactRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

type artifactExitError int

func (code artifactExitError) Error() string { return "exit" }
func (code artifactExitError) ExitCode() int { return int(code) }

func TestManagedArtifactInstallerAppliesVerifiedBundles(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	for _, test := range []struct {
		target     string
		version    string
		installDir string
	}{{
		target:     "linux-x64",
		version:    "0.4.9",
		installDir: "/safe/linux-bin",
	}, {
		target:     "darwin-arm64",
		version:    "0.27.0",
		installDir: "/safe/macos-bin",
	}} {
		t.Run(test.target, func(t *testing.T) {
			archive := testArtifactArchive(t, test.target, test.version, nil)
			digest := sha256.Sum256(archive)
			var calls []string
			runner := func(
				_ context.Context,
				command string,
				arguments []string,
				directory string,
				environment []string,
				stdout io.Writer,
				_ io.Writer,
			) error {
				calls = append(calls, filepath.Base(command))
				if len(calls) == 1 {
					if filepath.Base(command) != "install.sh" ||
						!reflect.DeepEqual(arguments, []string{"--install-dir", test.installDir}) ||
						!reflect.DeepEqual(environment, []string{"HOME=/safe/home", "LC_ALL=C", "PATH=/usr/bin:/bin"}) {
						t.Fatalf("installer invocation = %q %#v %#v", command, arguments, environment)
					}
					if _, err := os.Stat(filepath.Join(directory, "project-codex-host")); err != nil {
						t.Fatal(err)
					}
					return nil
				}
				_, _ = io.WriteString(stdout, "Project "+test.version+"\n")
				return nil
			}
			installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
				Client:             &http.Client{Transport: testArtifactTransport(archive)},
				CommandRunner:      runner,
				HomeDirectory:      "/safe/home",
				TemporaryDirectory: t.TempDir(),
			})
			outcome, err := installer.Apply(
				context.Background(),
				Installation{InstallDir: test.installDir, Source: InstallSourceManaged, Target: test.target},
				Release{
					Artifact: Artifact{
						AssetName:   "project-space-machine-tools-" + test.target + "-v" + test.version + ".tar.gz",
						DownloadURL: "https://github.com/DotNaos/project-space/releases/download/v" + test.version + "/project-space-machine-tools-" + test.target + "-v" + test.version + ".tar.gz",
						SHA256:      hex.EncodeToString(digest[:]),
						SizeBytes:   int64(len(archive)),
						Target:      test.target,
					},
					Manifest: Manifest{ReleaseID: "v" + test.version, Version: test.version},
				},
				io.Discard,
				io.Discard,
			)
			if err != nil || outcome != ApplyOutcomeUpdated {
				t.Fatalf("Apply() = %q, %v", outcome, err)
			}
			if !reflect.DeepEqual(calls, []string{"install.sh", "project", "project-codex-host"}) {
				t.Fatalf("calls = %#v", calls)
			}
		})
	}
}

func TestManagedArtifactInstallerRejectsIncompleteDarwinBundleBeforeInstaller(t *testing.T) {
	archive := testArtifactArchive(t, "darwin-arm64", "0.27.0", func(files map[string][]byte) map[string][]byte {
		delete(files, "project-codex-host")
		return files
	})
	digest := sha256.Sum256(archive)
	calls := 0
	installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
		Client: &http.Client{Transport: testArtifactTransport(archive)},
		CommandRunner: func(context.Context, string, []string, string, []string, io.Writer, io.Writer) error {
			calls++
			return nil
		},
		TemporaryDirectory: t.TempDir(),
	}).(*managedArtifactInstaller)
	_, err := installer.Apply(
		context.Background(),
		Installation{InstallDir: "/safe/bin", Source: InstallSourceManaged, Target: "darwin-arm64"},
		Release{
			Artifact: Artifact{
				AssetName:   "project-space-machine-tools-darwin-arm64-v0.27.0.tar.gz",
				DownloadURL: "https://github.com/DotNaos/project-space/releases/download/v0.27.0/project-space-machine-tools-darwin-arm64-v0.27.0.tar.gz",
				SHA256:      hex.EncodeToString(digest[:]),
				SizeBytes:   int64(len(archive)),
				Target:      "darwin-arm64",
			},
			Manifest: Manifest{ReleaseID: "v0.27.0", Version: "0.27.0"},
		},
		io.Discard,
		io.Discard,
	)
	if err == nil || !strings.Contains(err.Error(), "bundle is incomplete") || calls != 0 {
		t.Fatalf("Apply() = %v, installer calls = %d", err, calls)
	}
}

func TestManagedArtifactInstallerAcceptsLegacyDarwinBundleContract(t *testing.T) {
	archive := testArtifactArchiveWithMembers(
		t,
		"darwin-arm64",
		"0.27.2",
		legacyDarwinBundleMembers(),
		nil,
	)
	archivePath := filepath.Join(t.TempDir(), "artifact.tar.gz")
	if err := os.WriteFile(archivePath, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{}).(*managedArtifactInstaller)
	bundleRoot, err := installer.extract(archivePath, t.TempDir(), "darwin-arm64", "0.27.2")
	if err != nil {
		t.Fatalf("extract() rejected the v0.21.23 Darwin contract: %v", err)
	}
	for name := range legacyDarwinBundleMembers() {
		if _, err := os.Stat(filepath.Join(bundleRoot, name)); err != nil {
			t.Fatalf("legacy member %q was not extracted: %v", name, err)
		}
	}
}

func TestArtifactEnvironmentPreservesOnlyTheWSLPowerShellDirectory(t *testing.T) {
	directory := t.TempDir()
	powershell := filepath.Join(directory, "powershell.exe")
	if err := os.WriteFile(powershell, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	want := []string{
		"HOME=/safe/home",
		"LC_ALL=C",
		"PATH=/usr/bin:/bin:" + directory,
	}
	if got := artifactEnvironment("/safe/home"); !reflect.DeepEqual(got, want) {
		t.Fatalf("artifactEnvironment() = %#v, want %#v", got, want)
	}
}

func TestManagedArtifactInstallerMapsInstallerAndPostCheckFailures(t *testing.T) {
	archive := testArtifactArchive(t, "linux-x64", "0.4.9", nil)
	digest := sha256.Sum256(archive)
	release := Release{
		Artifact: Artifact{
			AssetName:   "project-space-machine-tools-linux-x64-v0.4.9.tar.gz",
			DownloadURL: "https://github.com/DotNaos/project-space/releases/download/v0.4.9/project-space-machine-tools-linux-x64-v0.4.9.tar.gz",
			SHA256:      hex.EncodeToString(digest[:]),
			SizeBytes:   int64(len(archive)),
			Target:      "linux-x64",
		},
		Manifest: Manifest{ReleaseID: "v0.4.9", Version: "0.4.9"},
	}
	installation := Installation{InstallDir: "/safe/bin", Source: InstallSourceManaged, Target: "linux-x64"}
	for _, test := range []struct {
		name    string
		exit    int
		outcome ApplyOutcome
	}{
		{name: "rolled back", exit: 70, outcome: ApplyOutcomeRolledBack},
		{name: "recovery required", exit: 71, outcome: ApplyOutcomeRecoveryRequired},
		{name: "ordinary failure", exit: 1, outcome: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
				Client: &http.Client{Transport: testArtifactTransport(archive)},
				CommandRunner: func(context.Context, string, []string, string, []string, io.Writer, io.Writer) error {
					return artifactExitError(test.exit)
				},
				HomeDirectory:      "/safe/home",
				TemporaryDirectory: t.TempDir(),
			})
			outcome, err := installer.Apply(context.Background(), installation, release, io.Discard, io.Discard)
			if err == nil || outcome != test.outcome {
				t.Fatalf("Apply() = %q, %v", outcome, err)
			}
		})
	}

	calls := 0
	installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
		Client: &http.Client{Transport: testArtifactTransport(archive)},
		CommandRunner: func(_ context.Context, _ string, _ []string, _ string, _ []string, stdout io.Writer, _ io.Writer) error {
			calls++
			if calls > 1 {
				_, _ = io.WriteString(stdout, "0.4.8\n")
			}
			return nil
		},
		HomeDirectory:      "/safe/home",
		TemporaryDirectory: t.TempDir(),
	})
	outcome, err := installer.Apply(context.Background(), installation, release, io.Discard, io.Discard)
	if err == nil || outcome != ApplyOutcomeRecoveryRequired {
		t.Fatalf("post-check Apply() = %q, %v", outcome, err)
	}
}

func TestManagedArtifactInstallerRejectsUnsafeArchives(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string][]byte) map[string][]byte
	}{
		{
			name: "missing installer",
			mutate: func(files map[string][]byte) map[string][]byte {
				delete(files, "install.sh")
				return files
			},
		},
		{
			name: "wrong version",
			mutate: func(files map[string][]byte) map[string][]byte {
				files["VERSION"] = []byte("0.4.8\n")
				return files
			},
		},
		{
			name: "unexpected file",
			mutate: func(files map[string][]byte) map[string][]byte {
				files["secret"] = []byte("no")
				return files
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			archive := testArtifactArchive(t, "linux-x64", "0.4.9", test.mutate)
			path := filepath.Join(t.TempDir(), "artifact.tar.gz")
			if err := os.WriteFile(path, archive, 0o600); err != nil {
				t.Fatal(err)
			}
			installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{}).(*managedArtifactInstaller)
			if _, err := installer.extract(path, t.TempDir(), "linux-x64", "0.4.9"); err == nil {
				t.Fatal("unsafe archive was accepted")
			}
		})
	}
}

func TestManagedArtifactInstallerRejectsNonGitHubAssetURL(t *testing.T) {
	archive := testArtifactArchive(t, "linux-x64", "0.4.9", nil)
	digest := sha256.Sum256(archive)
	installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
		Client:             &http.Client{Transport: testArtifactTransport(archive)},
		TemporaryDirectory: t.TempDir(),
	}).(*managedArtifactInstaller)
	_, err := installer.download(
		context.Background(),
		Artifact{
			AssetName:   "project-space-machine-tools-linux-x64-v0.4.9.tar.gz",
			DownloadURL: "https://example.test/project-space-machine-tools-linux-x64-v0.4.9.tar.gz",
			SHA256:      hex.EncodeToString(digest[:]),
			SizeBytes:   int64(len(archive)),
			Target:      "linux-x64",
		},
		t.TempDir(),
	)
	if err == nil || !strings.Contains(err.Error(), "exact HTTPS") {
		t.Fatalf("download() error = %v", err)
	}
}

func TestManagedArtifactInstallerRejectsArtifactIntegrityMismatch(t *testing.T) {
	archive := testArtifactArchive(t, "linux-x64", "0.4.9", nil)
	digest := sha256.Sum256(archive)
	base := Artifact{
		AssetName:   "project-space-machine-tools-linux-x64-v0.4.9.tar.gz",
		DownloadURL: "https://github.com/DotNaos/project-space/releases/download/v0.4.9/project-space-machine-tools-linux-x64-v0.4.9.tar.gz",
		SHA256:      hex.EncodeToString(digest[:]),
		SizeBytes:   int64(len(archive)),
		Target:      "linux-x64",
	}
	for _, test := range []struct {
		name   string
		mutate func(*Artifact)
	}{
		{name: "wrong size", mutate: func(artifact *Artifact) { artifact.SizeBytes++ }},
		{name: "wrong checksum", mutate: func(artifact *Artifact) { artifact.SHA256 = strings.Repeat("0", 64) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			artifact := base
			test.mutate(&artifact)
			installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{
				Client:             &http.Client{Transport: testArtifactTransport(archive)},
				TemporaryDirectory: t.TempDir(),
			}).(*managedArtifactInstaller)
			if _, err := installer.download(context.Background(), artifact, t.TempDir()); err == nil {
				t.Fatal("artifact integrity mismatch was accepted")
			}
		})
	}
}

func TestSafeArchiveNameRejectsTraversal(t *testing.T) {
	root := "project-space-machine-tools-linux-x64-v0.4.9"
	for _, name := range []string{
		"../" + root + "/project",
		root + "/../project",
		root + "\\project",
		"/" + root + "/project",
	} {
		if _, err := safeArchiveName(name, root); err == nil {
			t.Errorf("safeArchiveName(%q) succeeded", name)
		}
	}
}

func TestManagedArtifactInstallerRejectsLinkDeviceAndDuplicateMembers(t *testing.T) {
	root := "project-space-machine-tools-linux-x64-v0.4.9"
	tests := []struct {
		name    string
		headers []*tar.Header
	}{
		{
			name: "link",
			headers: []*tar.Header{
				{Name: root + "/", Typeflag: tar.TypeDir},
				{Name: root + "/project", Typeflag: tar.TypeSymlink, Linkname: "/tmp/project"},
			},
		},
		{
			name: "device",
			headers: []*tar.Header{
				{Name: root + "/", Typeflag: tar.TypeDir},
				{Name: root + "/project", Typeflag: tar.TypeChar},
			},
		},
		{
			name: "duplicate",
			headers: []*tar.Header{
				{Name: root + "/", Typeflag: tar.TypeDir},
				{Name: root + "/", Typeflag: tar.TypeDir},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var body bytes.Buffer
			compressed := gzip.NewWriter(&body)
			archive := tar.NewWriter(compressed)
			for _, header := range test.headers {
				if err := archive.WriteHeader(header); err != nil {
					t.Fatal(err)
				}
			}
			if err := errors.Join(archive.Close(), compressed.Close()); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "artifact.tar.gz")
			if err := os.WriteFile(path, body.Bytes(), 0o600); err != nil {
				t.Fatal(err)
			}
			installer := NewManagedArtifactInstaller(ArtifactInstallerOptions{}).(*managedArtifactInstaller)
			if _, err := installer.extract(path, t.TempDir(), "linux-x64", "0.4.9"); err == nil {
				t.Fatal("unsafe archive was accepted")
			}
		})
	}
}

func testArtifactTransport(body []byte) http.RoundTripper {
	return artifactRoundTripper(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			Body:          io.NopCloser(bytes.NewReader(body)),
			ContentLength: int64(len(body)),
			Header:        make(http.Header),
			Request:       request,
			StatusCode:    http.StatusOK,
		}, nil
	})
}

func testArtifactArchive(
	t *testing.T,
	target, version string,
	mutate func(map[string][]byte) map[string][]byte,
) []byte {
	t.Helper()
	members, ok := archiveBundleMembers(target)
	if !ok {
		t.Fatal("unsupported test target")
	}
	return testArtifactArchiveWithMembers(t, target, version, members, mutate)
}

func testArtifactArchiveWithMembers(
	t *testing.T,
	target, version string,
	members map[string]fs.FileMode,
	mutate func(map[string][]byte) map[string][]byte,
) []byte {
	t.Helper()
	files := make(map[string][]byte, len(members))
	for name := range members {
		if name != "SHA256SUMS.txt" {
			files[name] = []byte(name + "\n")
		}
	}
	files["VERSION"] = []byte(version + "\n")
	if mutate != nil {
		files = mutate(files)
	}
	var checksum strings.Builder
	for name := range members {
		if name == "SHA256SUMS.txt" {
			continue
		}
		body, found := files[name]
		if !found {
			continue
		}
		digest := sha256.Sum256(body)
		checksum.WriteString(hex.EncodeToString(digest[:]) + "  " + name + "\n")
	}
	files["SHA256SUMS.txt"] = []byte(checksum.String())

	var compressed bytes.Buffer
	gzipWriter := gzip.NewWriter(&compressed)
	tarWriter := tar.NewWriter(gzipWriter)
	root := "project-space-machine-tools-" + target + "-v" + version
	if err := tarWriter.WriteHeader(&tar.Header{Name: root + "/", Mode: 0o755, Typeflag: tar.TypeDir}); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if err := tarWriter.WriteHeader(&tar.Header{
			Name: root + "/" + name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := errors.Join(tarWriter.Close(), gzipWriter.Close()); err != nil {
		t.Fatal(err)
	}
	return compressed.Bytes()
}
