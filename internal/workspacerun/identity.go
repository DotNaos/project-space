package workspacerun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const workspaceIdentityVersion = "project-workspace-v1"

type GitIdentityResolver struct {
	Run func(context.Context, string, ...string) (string, error)
}

func (resolver GitIdentityResolver) Resolve(ctx context.Context, directory string) (WorkspaceIdentity, error) {
	worktree, err := canonicalDirectory(directory)
	if err != nil {
		return WorkspaceIdentity{}, err
	}
	run := resolver.Run
	if run == nil {
		run = gitOutput
	}
	common, err := run(ctx, "git", "-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return WorkspaceIdentity{}, fmt.Errorf("resolve git common directory: %w", err)
	}
	gitDirectory, err := run(ctx, "git", "-C", worktree, "rev-parse", "--path-format=absolute", "--absolute-git-dir")
	if err != nil {
		return WorkspaceIdentity{}, fmt.Errorf("resolve git worktree directory: %w", err)
	}
	repository, err := canonicalGitDirectory(strings.TrimSpace(common))
	if err != nil {
		return WorkspaceIdentity{}, fmt.Errorf("resolve git common directory: %w", err)
	}
	gitDirectory, err = canonicalGitDirectory(strings.TrimSpace(gitDirectory))
	if err != nil {
		return WorkspaceIdentity{}, fmt.Errorf("resolve git worktree directory: %w", err)
	}
	branch, err := run(ctx, "git", "-C", worktree, "branch", "--show-current")
	if err != nil || strings.TrimSpace(branch) == "" {
		return WorkspaceIdentity{}, fmt.Errorf("resolve git branch: a dedicated branch is required")
	}
	head, err := run(ctx, "git", "-C", worktree, "rev-parse", "--verify", "HEAD")
	if err != nil || !fullObjectID(strings.TrimSpace(head)) {
		return WorkspaceIdentity{}, fmt.Errorf("resolve git HEAD: a full commit ID is required")
	}
	dirty, err := run(ctx, "git", "-C", worktree, "status", "--porcelain=v1", "--untracked-files=normal")
	if err != nil {
		return WorkspaceIdentity{}, fmt.Errorf("inspect git worktree: %w", err)
	}
	instance, err := gitDirectoryInstance(gitDirectory)
	if err != nil {
		return WorkspaceIdentity{}, err
	}
	payload := strings.Join([]string{workspaceIdentityVersion, repository, gitDirectory, instance}, "\x00")
	digest := sha256.Sum256([]byte(payload))
	proof := hex.EncodeToString(digest[:])
	return WorkspaceIdentity{
		WorkspaceID:   "ws_" + proof[:24],
		Repository:    repository,
		Directory:     worktree,
		GitDirectory:  gitDirectory,
		Branch:        strings.TrimSpace(branch),
		Head:          strings.TrimSpace(head),
		Dirty:         strings.TrimSpace(dirty) != "",
		IdentityProof: proof,
		Owner:         strings.TrimSpace(os.Getenv("CODEX_THREAD_ID")),
	}, nil
}

func gitDirectoryInstance(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("inspect git worktree identity: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("git worktree identity is unavailable on this platform")
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}

func fullObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, character := range value {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}

func canonicalGitDirectory(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%q is not a directory", resolved)
	}
	return filepath.Clean(resolved), nil
}

func gitOutput(ctx context.Context, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Env = filteredEnvironment(os.Environ())
	body, err := command.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}

func filteredEnvironment(environment []string) []string {
	allowed := map[string]bool{
		"HOME": true, "LANG": true, "LC_ALL": true, "PATH": true,
		"SSL_CERT_DIR": true, "SSL_CERT_FILE": true, "TEMP": true,
		"TMP": true, "TMPDIR": true, "TZ": true,
	}
	result := make([]string, 0, len(allowed))
	for _, entry := range environment {
		key, _, ok := strings.Cut(entry, "=")
		if ok && (allowed[key] || strings.HasPrefix(key, "LC_")) {
			result = append(result, entry)
		}
	}
	return result
}
