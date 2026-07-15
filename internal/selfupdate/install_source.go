package selfupdate

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const managedToolsDirectory = ".project-space-machine-tools"
const maximumVersionOutputBytes = 4096

// InstallDetectorOptions makes installation discovery deterministic in tests.
// Empty function fields use their os package equivalents.
type InstallDetectorOptions struct {
	CurrentVersion   string
	ExecutablePath   string
	GOARCH           string
	GOOS             string
	HomeDirectory    string
	LocalAppData     string
	WorkingDirectory string
	EvalSymlinks     func(string) (string, error)
	Lstat            func(string) (fs.FileInfo, error)
	ReadFile         func(string) ([]byte, error)
	Readlink         func(string) (string, error)
	ReadVersion      func(string) (string, error)
}

type installDetector struct {
	options InstallDetectorOptions
}

func NewInstallDetector(options InstallDetectorOptions) InstallDetector {
	if options.GOOS == "" {
		options.GOOS = runtime.GOOS
	}
	if options.GOARCH == "" {
		options.GOARCH = runtime.GOARCH
	}
	if options.EvalSymlinks == nil {
		options.EvalSymlinks = filepath.EvalSymlinks
	}
	if options.Lstat == nil {
		options.Lstat = os.Lstat
	}
	if options.ReadFile == nil {
		options.ReadFile = os.ReadFile
	}
	if options.Readlink == nil {
		options.Readlink = os.Readlink
	}
	if options.ReadVersion == nil {
		options.ReadVersion = readExecutableVersion
	}
	return &installDetector{options: options}
}

func NewDefaultInstallDetector(currentVersion string) InstallDetector {
	executable := invokedExecutablePath()
	workingDirectory, _ := os.Getwd()
	homeDirectory, _ := os.UserHomeDir()
	return NewInstallDetector(InstallDetectorOptions{
		CurrentVersion:   currentVersion,
		ExecutablePath:   executable,
		HomeDirectory:    homeDirectory,
		LocalAppData:     os.Getenv("LOCALAPPDATA"),
		WorkingDirectory: workingDirectory,
	})
}

func invokedExecutablePath() string {
	if len(os.Args) > 0 && os.Args[0] != "" {
		if strings.ContainsAny(os.Args[0], `/\`) {
			if absolute, err := filepath.Abs(os.Args[0]); err == nil {
				return absolute
			}
		} else if resolved, err := exec.LookPath(os.Args[0]); err == nil {
			if absolute, absoluteErr := filepath.Abs(resolved); absoluteErr == nil {
				return absolute
			}
		}
	}
	executable, _ := os.Executable()
	return executable
}

func (detector *installDetector) Detect() (Installation, error) {
	options := detector.options
	target := installationTarget(options.GOOS, options.GOARCH)
	unknown := Installation{
		CurrentVersion: options.CurrentVersion,
		ExecutablePath: options.ExecutablePath,
		Source:         InstallSourceUnknown,
		Target:         target,
	}
	if options.ExecutablePath == "" {
		return unknown, nil
	}

	resolved, err := options.EvalSymlinks(options.ExecutablePath)
	if err != nil {
		return unknown, nil
	}
	if detector.isSourceCheckout(resolved) {
		unknown.ExecutablePath = resolved
		unknown.InstallDir = filepath.Dir(resolved)
		unknown.Source = InstallSourceSourceCheckout
		return unknown, nil
	}
	if isHomebrewExecutable(resolved) {
		unknown.ExecutablePath = resolved
		unknown.InstallDir = filepath.Dir(options.ExecutablePath)
		unknown.Source = InstallSourceHomebrew
		return unknown, nil
	}
	if options.GOOS == "windows" {
		return detector.detectWindows(unknown, options.ExecutablePath), nil
	}
	if target == "darwin-arm64" || target == "linux-x64" {
		return detector.detectManagedUnix(unknown, resolved)
	}
	return unknown, nil
}

func installationTarget(goos, goarch string) string {
	switch {
	case goos == "darwin" && goarch == "arm64":
		return "darwin-arm64"
	case goos == "linux" && (goarch == "amd64" || goarch == "x64"):
		return "linux-x64"
	case goos == "windows" && (goarch == "amd64" || goarch == "x64"):
		return "windows-x64"
	default:
		return ""
	}
}

func (detector *installDetector) isSourceCheckout(resolvedExecutable string) bool {
	root, found := findProjectSourceRoot(
		resolvedExecutable,
		detector.options.Lstat,
		detector.options.ReadFile,
	)
	if found && pathWithin(root, resolvedExecutable) {
		return true
	}
	if !strings.Contains(filepath.ToSlash(resolvedExecutable), "/go-build") {
		return false
	}
	_, found = findProjectSourceRoot(
		detector.options.WorkingDirectory,
		detector.options.Lstat,
		detector.options.ReadFile,
	)
	return found
}

func findProjectSourceRoot(
	start string,
	lstat func(string) (fs.FileInfo, error),
	readFile func(string) ([]byte, error),
) (string, bool) {
	if start == "" {
		return "", false
	}
	current := filepath.Clean(start)
	if info, err := lstat(current); err == nil && !info.IsDir() {
		current = filepath.Dir(current)
	}
	for {
		goModPath := filepath.Join(current, "go.mod")
		goMod, goModErr := lstat(goModPath)
		_, gitErr := lstat(filepath.Join(current, ".git"))
		if goModErr == nil && goMod.Mode().IsRegular() && gitErr == nil {
			body, readErr := readFile(goModPath)
			if readErr == nil && projectModuleFile(body) {
				return current, true
			}
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", false
		}
		current = parent
	}
}

func projectModuleFile(body []byte) bool {
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		return line == "module github.com/DotNaos/project-space"
	}
	return false
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func isHomebrewExecutable(resolved string) bool {
	path := filepath.ToSlash(filepath.Clean(resolved))
	return filepath.Base(resolved) == "project" &&
		(strings.Contains(path, "/Cellar/project/") || strings.Contains(path, "/Homebrew/Cellar/project/"))
}

func (detector *installDetector) detectWindows(unknown Installation, resolved string) Installation {
	localAppData := detector.options.LocalAppData
	if localAppData == "" {
		localAppData = filepath.Join(detector.options.HomeDirectory, "AppData", "Local")
	}
	installDir := windowsJoin(localAppData, "Programs", "Project Space")
	expectedProject := windowsJoin(installDir, "project.exe")
	expectedConnector := windowsJoin(installDir, "project-space-connector.exe")
	if !windowsPathEqual(resolved, expectedProject) ||
		!regularFile(expectedProject, detector.options.Lstat) ||
		!regularFile(expectedConnector, detector.options.Lstat) {
		return unknown
	}
	unknown.ExecutablePath = resolved
	unknown.InstallDir = installDir
	unknown.Source = InstallSourceWindows
	return unknown
}

func windowsJoin(components ...string) string {
	joined := strings.TrimRight(strings.ReplaceAll(components[0], "\\", "/"), "/")
	for _, component := range components[1:] {
		joined += "/" + strings.Trim(component, "/\\")
	}
	return joined
}

func windowsPathEqual(left, right string) bool {
	normalize := func(value string) string {
		return strings.ToLower(strings.TrimRight(strings.ReplaceAll(value, "\\", "/"), "/"))
	}
	return normalize(left) == normalize(right)
}

func (detector *installDetector) detectManagedUnix(unknown Installation, resolved string) (Installation, error) {
	installDir := filepath.Dir(detector.options.ExecutablePath)
	toolsRoot := filepath.Join(installDir, managedToolsDirectory)
	current := filepath.Join(toolsRoot, "current")
	releaseID := filepath.Base(filepath.Dir(resolved))
	expectedProject, err := detector.options.EvalSymlinks(filepath.Join(
		toolsRoot, "versions", releaseID, "project",
	))
	if !validReleaseID(releaseID, detector.options.CurrentVersion) || err != nil ||
		filepath.Clean(resolved) != filepath.Clean(expectedProject) {
		return unknown, nil
	}
	if !exactSymlink(detector.options.ExecutablePath, filepath.ToSlash(filepath.Join(
		managedToolsDirectory, "current", "project",
	)), detector.options.Lstat, detector.options.Readlink) ||
		!exactSymlink(filepath.Join(installDir, "project-space-connector"), filepath.ToSlash(filepath.Join(
			managedToolsDirectory, "current", "project-space-connector",
		)), detector.options.Lstat, detector.options.Readlink) ||
		!exactSymlink(
			current,
			filepath.ToSlash(filepath.Join("versions", releaseID)),
			detector.options.Lstat,
			detector.options.Readlink,
		) {
		return unknown, nil
	}
	connector := filepath.Join(toolsRoot, "versions", releaseID, "project-space-connector")
	resolvedConnector, err := detector.options.EvalSymlinks(filepath.Join(installDir, "project-space-connector"))
	expectedConnector, expectedErr := detector.options.EvalSymlinks(connector)
	if err != nil || expectedErr != nil || filepath.Clean(resolvedConnector) != filepath.Clean(expectedConnector) ||
		!regularFile(resolved, detector.options.Lstat) || !regularFile(connector, detector.options.Lstat) {
		return unknown, nil
	}
	versionPath := filepath.Join(filepath.Dir(resolved), "VERSION")
	if !regularFile(versionPath, detector.options.Lstat) {
		return unknown, nil
	}
	version, err := detector.options.ReadFile(versionPath)
	if err != nil || string(version) != detector.options.CurrentVersion+"\n" {
		return unknown, nil
	}
	connectorVersion, err := detector.options.ReadVersion(connector)
	if err != nil || !versionOutputMatches(connectorVersion, detector.options.CurrentVersion) {
		return unknown, fmt.Errorf("verify managed connector version: %w", errOrMismatch(err))
	}
	unknown.ExecutablePath = resolved
	unknown.InstallDir = installDir
	unknown.Source = InstallSourceManaged
	return unknown, nil
}

func readExecutableVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, path, "--version")
	command.Env = []string{"LC_ALL=C", "PATH=/usr/bin:/bin"}
	output := &boundedVersionOutput{}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if output.overflowed() {
		return "", fmt.Errorf("version output exceeds %d bytes", maximumVersionOutputBytes)
	}
	return output.String(), err
}

type boundedVersionOutput struct {
	mutex    sync.Mutex
	bytes    []byte
	overflow bool
}

func (output *boundedVersionOutput) Write(value []byte) (int, error) {
	output.mutex.Lock()
	defer output.mutex.Unlock()
	written := len(value)
	remaining := maximumVersionOutputBytes - len(output.bytes)
	if remaining < len(value) {
		output.overflow = true
	}
	if remaining > 0 {
		output.bytes = append(output.bytes, value[:min(remaining, len(value))]...)
	}
	return written, nil
}

func (output *boundedVersionOutput) overflowed() bool {
	output.mutex.Lock()
	defer output.mutex.Unlock()
	return output.overflow
}

func (output *boundedVersionOutput) String() string {
	output.mutex.Lock()
	defer output.mutex.Unlock()
	return string(output.bytes)
}

func errOrMismatch(err error) error {
	if err != nil {
		return err
	}
	return fmt.Errorf("version output does not match the Project CLI")
}

func validReleaseID(releaseID, version string) bool {
	prefix := version + "-"
	if version == "" || !strings.HasPrefix(releaseID, prefix) || len(releaseID) != len(prefix)+16 {
		return false
	}
	for _, character := range releaseID[len(prefix):] {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}

func exactSymlink(
	path, target string,
	lstat func(string) (fs.FileInfo, error),
	readlink func(string) (string, error),
) bool {
	info, err := lstat(path)
	if err != nil || info.Mode()&fs.ModeSymlink == 0 {
		return false
	}
	actual, err := readlink(path)
	return err == nil && filepath.ToSlash(actual) == target
}

func regularFile(path string, lstat func(string) (fs.FileInfo, error)) bool {
	info, err := lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&fs.ModeSymlink == 0
}

var _ InstallDetector = (*installDetector)(nil)
