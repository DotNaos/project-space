package main

import (
	"context"
	"crypto/sha1" // Runtime build IDs use the repository's 40-character Git-compatible shape.
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

const connectorSourceLauncher = `#!/bin/sh
set -eu
root="$1"
bun="$2"
build_id="$3"
release_id="$4"
cd "$root"
export PROJECT_SPACE_RELEASE_CHANNEL=dev
export PROJECT_SPACE_INSTALL_SOURCE=source
export PROJECT_SPACE_BUILD_ID="$build_id"
export PROJECT_SPACE_RELEASE_ID="$release_id"
exec "$bun" --no-env-file server/web-server.ts
`

var connectorSourceRevisionPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

type connectorSourceState struct {
	BuildID  string
	Dirty    bool
	Revision string
}

type connectorSourceLaunch struct {
	Executable string
	Directory  string
	BuildID    string
	ReleaseID  string
	Revision   string
}

type connectorSourceSupervisorCommand struct {
	Executable string
	Arguments  []string
}

type connectorSourceCompanionDependencies struct {
	LookPath           func(string) (string, error)
	ResolveSourceState func(context.Context, string) (connectorSourceState, error)
}

func defaultConnectorSourceCompanionDependencies() connectorSourceCompanionDependencies {
	return connectorSourceCompanionDependencies{
		LookPath:           exec.LookPath,
		ResolveSourceState: resolveConnectorSourceState,
	}
}

func resolveConnectorSourceLaunch(
	ctx context.Context,
	root string,
	dependencies connectorSourceCompanionDependencies,
) (connectorSourceLaunch, error) {
	if ctx == nil {
		return connectorSourceLaunch{}, errors.New("source connector context is missing")
	}
	if dependencies.LookPath == nil || dependencies.ResolveSourceState == nil {
		return connectorSourceLaunch{}, errors.New("source connector dependencies are incomplete")
	}
	canonicalRoot, err := canonicalConnectorSourceRoot(root)
	if err != nil {
		return connectorSourceLaunch{}, err
	}
	bun, err := dependencies.LookPath("bun")
	if err != nil || strings.TrimSpace(bun) == "" || strings.ContainsRune(bun, '\x00') {
		return connectorSourceLaunch{}, errors.New("source connector requires Bun on PATH")
	}
	state, err := dependencies.ResolveSourceState(ctx, canonicalRoot)
	if err != nil || !connectorSourceRevisionPattern.MatchString(state.Revision) ||
		!connectorSourceRevisionPattern.MatchString(state.BuildID) {
		return connectorSourceLaunch{}, errors.New("source connector revision is invalid")
	}
	releaseID := "dev-source-" + state.Revision
	if state.Dirty {
		releaseID += "-dirty"
	}
	return connectorSourceLaunch{
		Executable: bun,
		Directory:  canonicalRoot,
		BuildID:    state.BuildID,
		ReleaseID:  releaseID,
		Revision:   state.Revision,
	}, nil
}

func prepareConnectorSourceSupervisorCommand(
	ctx context.Context,
	profile machineconnect.ConnectorProfile,
	root string,
	dependencies connectorSourceCompanionDependencies,
) (connectorSourceSupervisorCommand, error) {
	if err := machineconnect.ValidateConnectorProfile(profile); err != nil {
		return connectorSourceSupervisorCommand{}, err
	}
	launch, err := resolveConnectorSourceLaunch(ctx, root, dependencies)
	if err != nil {
		return connectorSourceSupervisorCommand{}, err
	}
	if runtime.GOOS == "windows" {
		return connectorSourceSupervisorCommand{}, errors.New("source connector launcher requires macOS, Linux, or WSL")
	}
	if err := installConnectorSourceLauncher(profile.LauncherPath); err != nil {
		return connectorSourceSupervisorCommand{}, err
	}
	return connectorSourceSupervisorCommand{
		Executable: "/bin/sh",
		Arguments: []string{
			profile.LauncherPath,
			launch.Directory,
			launch.Executable,
			launch.BuildID,
			launch.ReleaseID,
		},
	}, nil
}

func resolveConnectorSourceState(ctx context.Context, root string) (connectorSourceState, error) {
	topLevel, err := connectorSourceGitOutput(ctx, root, "rev-parse", "--show-toplevel")
	if err != nil {
		return connectorSourceState{}, err
	}
	canonicalTopLevel, err := filepath.EvalSymlinks(strings.TrimSpace(string(topLevel)))
	if err != nil || canonicalTopLevel != root {
		return connectorSourceState{}, errors.New("source connector root must be the Git checkout root")
	}
	revisionOutput, err := connectorSourceGitOutput(ctx, root, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return connectorSourceState{}, err
	}
	revision := strings.TrimSpace(string(revisionOutput))
	if !connectorSourceRevisionPattern.MatchString(revision) {
		return connectorSourceState{}, errors.New("source connector revision is invalid")
	}
	status, err := connectorSourceGitOutput(ctx, root, "status", "--porcelain=v1", "--untracked-files=all")
	if err != nil {
		return connectorSourceState{}, err
	}
	if len(status) == 0 {
		return connectorSourceState{BuildID: revision, Revision: revision}, nil
	}
	fingerprint, err := fingerprintDirtyConnectorSource(ctx, root, revision, status)
	if err != nil {
		return connectorSourceState{}, err
	}
	return connectorSourceState{BuildID: fingerprint, Dirty: true, Revision: revision}, nil
}

func connectorSourceGitOutput(ctx context.Context, root string, arguments ...string) ([]byte, error) {
	commandArguments := append([]string{"-C", root}, arguments...)
	output, err := exec.CommandContext(ctx, "git", commandArguments...).Output()
	if err != nil {
		return nil, errors.New("inspect source connector revision")
	}
	return output, nil
}

func fingerprintDirtyConnectorSource(
	ctx context.Context,
	root string,
	revision string,
	status []byte,
) (string, error) {
	diff, err := connectorSourceGitOutput(ctx, root, "diff", "--binary", "HEAD", "--")
	if err != nil {
		return "", err
	}
	untracked, err := connectorSourceGitOutput(ctx, root, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return "", err
	}
	hash := sha1.New()
	_, _ = hash.Write([]byte(revision))
	_, _ = hash.Write(status)
	_, _ = hash.Write(diff)
	for _, rawPath := range strings.Split(string(untracked), "\x00") {
		if rawPath == "" {
			continue
		}
		path := filepath.Join(root, filepath.FromSlash(rawPath))
		relative, err := filepath.Rel(root, path)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
			return "", errors.New("source connector contains an unsafe untracked path")
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return "", errors.New("fingerprint dirty source connector")
		}
		_, _ = hash.Write([]byte(rawPath))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write(body)
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func canonicalConnectorSourceRoot(root string) (string, error) {
	if root == "" || strings.TrimSpace(root) != root || strings.ContainsRune(root, '\x00') {
		return "", errors.New("source connector root is invalid")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", errors.New("resolve source connector root")
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", errors.New("resolve source connector root")
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() {
		return "", errors.New("source connector root is not a directory")
	}
	for _, relative := range []string{"package.json", filepath.Join("server", "web-server.ts")} {
		path := filepath.Join(canonical, relative)
		entry, err := os.Lstat(path)
		if err != nil || entry.Mode()&os.ModeSymlink != 0 || !entry.Mode().IsRegular() {
			return "", fmt.Errorf("source connector checkout is missing trusted %s", filepath.ToSlash(relative))
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || filepath.Dir(resolved) != filepath.Dir(path) {
			return "", fmt.Errorf("source connector checkout has unsafe %s", filepath.ToSlash(relative))
		}
	}
	return canonical, nil
}

func installConnectorSourceLauncher(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("source connector launcher path is invalid")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create source connector state directory: %w", err)
	}
	if info, err := os.Lstat(directory); err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("source connector state directory is unsafe")
	}
	if info, err := os.Lstat(path); err == nil &&
		(info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular()) {
		return errors.New("source connector launcher path is unsafe")
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("inspect source connector launcher: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".source-launcher-")
	if err != nil {
		return fmt.Errorf("create source connector launcher: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure source connector launcher: %w", err)
	}
	if _, err := temporary.WriteString(connectorSourceLauncher); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write source connector launcher: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close source connector launcher: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("install source connector launcher: %w", err)
	}
	return os.Chmod(path, 0o600)
}
