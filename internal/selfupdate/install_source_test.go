package selfupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstallDetectorRecognizesExactManagedLayout(t *testing.T) {
	root := t.TempDir()
	installDir := filepath.Join(root, "bin")
	releaseID := "0.4.8-0123456789abcdef"
	releaseDir := filepath.Join(installDir, managedToolsDirectory, "versions", releaseID)
	mustMkdirAll(t, releaseDir)
	mustWriteDetectorFile(t, filepath.Join(releaseDir, "project"), "project", 0o700)
	mustWriteDetectorFile(t, filepath.Join(releaseDir, "project-space-connector"), "connector", 0o700)
	mustWriteDetectorFile(t, filepath.Join(releaseDir, "VERSION"), "0.4.8\n", 0o600)
	mustSymlink(t, "versions/"+releaseID, filepath.Join(installDir, managedToolsDirectory, "current"))
	mustSymlink(t, ".project-space-machine-tools/current/project", filepath.Join(installDir, "project"))
	mustSymlink(t, ".project-space-machine-tools/current/project-space-connector", filepath.Join(installDir, "project-space-connector"))

	installation, err := NewInstallDetector(InstallDetectorOptions{
		CurrentVersion: "0.4.8",
		ExecutablePath: filepath.Join(installDir, "project"),
		GOARCH:         "arm64",
		GOOS:           "darwin",
		ReadVersion:    func(string) (string, error) { return "project-space-connector 0.4.8\n", nil },
	}).Detect()
	if err != nil {
		t.Fatal(err)
	}
	expectedExecutable, err := filepath.EvalSymlinks(filepath.Join(releaseDir, "project"))
	if err != nil {
		t.Fatal(err)
	}
	if installation.Source != InstallSourceManaged || installation.Target != "darwin-arm64" ||
		installation.InstallDir != installDir || installation.ExecutablePath != expectedExecutable {
		t.Fatalf("installation = %#v", installation)
	}
	mismatched, mismatchErr := NewInstallDetector(InstallDetectorOptions{
		CurrentVersion: "0.4.8",
		ExecutablePath: filepath.Join(installDir, "project"),
		GOARCH:         "arm64",
		GOOS:           "darwin",
		ReadVersion:    func(string) (string, error) { return "project-space-connector 0.4.7\n", nil },
	}).Detect()
	if mismatchErr == nil || mismatched.Source != InstallSourceUnknown {
		t.Fatalf("mismatched connector installation = %#v, %v", mismatched, mismatchErr)
	}

	if err := os.Remove(filepath.Join(installDir, "project-space-connector")); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, filepath.Join(releaseDir, "project-space-connector"), filepath.Join(installDir, "project-space-connector"))
	installation, err = NewInstallDetector(InstallDetectorOptions{
		CurrentVersion: "0.4.8",
		ExecutablePath: filepath.Join(installDir, "project"),
		GOARCH:         "arm64",
		GOOS:           "darwin",
		ReadVersion:    func(string) (string, error) { return "project-space-connector 0.4.8\n", nil },
	}).Detect()
	if err != nil {
		t.Fatal(err)
	}
	if installation.Source != InstallSourceUnknown {
		t.Fatalf("noncanonical connector link source = %q", installation.Source)
	}
}

func TestInstallDetectorClassifiesSourceBeforeHomebrew(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Homebrew", "Cellar", "project", "0.4.8")
	mustMkdirAll(t, filepath.Join(root, ".git"))
	mustWriteDetectorFile(t, filepath.Join(root, "go.mod"), "module github.com/DotNaos/project-space\n", 0o600)
	executable := filepath.Join(root, "project")
	mustWriteDetectorFile(t, executable, "project", 0o700)

	installation, err := NewInstallDetector(InstallDetectorOptions{
		CurrentVersion: "0.4.8",
		ExecutablePath: executable,
		GOARCH:         "arm64",
		GOOS:           "darwin",
	}).Detect()
	if err != nil {
		t.Fatal(err)
	}
	if installation.Source != InstallSourceSourceCheckout {
		t.Fatalf("source = %q", installation.Source)
	}
}

func TestInstallDetectorRecognizesHomebrewAndWindowsBoundaries(t *testing.T) {
	home := t.TempDir()
	brew := filepath.Join(home, "homebrew", "Cellar", "project", "0.4.8", "bin", "project")
	mustMkdirAll(t, filepath.Dir(brew))
	mustWriteDetectorFile(t, brew, "project", 0o700)
	brewConnector := filepath.Join(filepath.Dir(brew), "project-space-connector")
	mustWriteDetectorFile(t, brewConnector, "connector", 0o700)
	installation, err := NewInstallDetector(InstallDetectorOptions{
		CurrentVersion: "0.4.8",
		ExecutablePath: brew,
		GOARCH:         "arm64",
		GOOS:           "darwin",
		HomeDirectory:  home,
		ReadVersion: func(string) (string, error) {
			return "project-space-connector 0.4.8\n", nil
		},
	}).Detect()
	if err != nil || installation.Source != InstallSourceHomebrew {
		t.Fatalf("Homebrew installation = %#v, %v", installation, err)
	}
	if installation.InstallDir != filepath.Join(home, ".local", "bin") {
		t.Fatalf("managed migration destination = %q", installation.InstallDir)
	}
	if err := os.Remove(brewConnector); err != nil {
		t.Fatal(err)
	}
	installation, err = NewInstallDetector(InstallDetectorOptions{
		CurrentVersion: "0.4.8",
		ExecutablePath: brew,
		GOARCH:         "arm64",
		GOOS:           "darwin",
		HomeDirectory:  home,
	}).Detect()
	if err != nil || installation.Source != InstallSourceUnknown {
		t.Fatalf("Homebrew installation without connector = %#v, %v", installation, err)
	}

	localAppData := t.TempDir()
	installDir := windowsJoin(localAppData, "Programs", "Project Space")
	mustMkdirAll(t, installDir)
	project := windowsJoin(installDir, "project.exe")
	mustWriteDetectorFile(t, project, "project", 0o700)
	mustWriteDetectorFile(t, windowsJoin(installDir, "project-space-connector.exe"), "connector", 0o700)
	installation, err = NewInstallDetector(InstallDetectorOptions{
		CurrentVersion: "0.4.8",
		ExecutablePath: project,
		GOARCH:         "amd64",
		GOOS:           "windows",
		LocalAppData:   localAppData,
	}).Detect()
	if err != nil || installation.Source != InstallSourceWindows || installation.Target != "windows-x64" {
		t.Fatalf("Windows installation = %#v, %v", installation, err)
	}
	if err := os.Remove(windowsJoin(installDir, "project-space-connector.exe")); err != nil {
		t.Fatal(err)
	}
	installation, _ = NewInstallDetector(InstallDetectorOptions{
		CurrentVersion: "0.4.8", ExecutablePath: project, GOARCH: "amd64", GOOS: "windows", LocalAppData: localAppData,
	}).Detect()
	if installation.Source != InstallSourceUnknown {
		t.Fatalf("Windows installation without connector source = %q", installation.Source)
	}
}

func TestInstallationTargetIsStrict(t *testing.T) {
	tests := map[string]string{
		"darwin/arm64":  "darwin-arm64",
		"linux/amd64":   "linux-x64",
		"windows/amd64": "windows-x64",
		"darwin/amd64":  "",
		"linux/arm64":   "",
	}
	for input, expected := range tests {
		separator := len(input) - len(filepath.Base(input)) - 1
		if actual := installationTarget(input[:separator], input[separator+1:]); actual != expected {
			t.Errorf("installationTarget(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestInvokedExecutablePathPreservesStableCommandPath(t *testing.T) {
	previousArgs := os.Args
	t.Cleanup(func() { os.Args = previousArgs })
	root := t.TempDir()
	stable := filepath.Join(root, "project")
	mustWriteDetectorFile(t, stable, "project", 0o700)
	os.Args = []string{stable}
	if actual := invokedExecutablePath(); actual != stable {
		t.Fatalf("invokedExecutablePath() = %q, want %q", actual, stable)
	}
}

func TestReadExecutableVersionBoundsOutput(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "noisy-connector")
	mustWriteDetectorFile(t, executable, "#!/bin/sh\ni=0\nwhile [ $i -lt 5000 ]; do printf x; i=$((i + 1)); done\n", 0o700)
	if output, err := readExecutableVersion(executable); err == nil || output != "" {
		t.Fatalf("readExecutableVersion() = %q, %v", output, err)
	}
}

func mustMkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func mustWriteDetectorFile(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
}

func mustSymlink(t *testing.T, target, path string) {
	t.Helper()
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
}
