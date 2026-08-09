package worktreecheckout

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gofrs/flock"
)

var (
	repositoryPartPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$`)
	commitPattern         = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)
)

type Request struct {
	Branch        string
	Commit        string
	Repository    string
	WorktreesRoot string
}

type Result struct {
	Branch     string `json:"branch"`
	Commit     string `json:"commit"`
	Path       string `json:"path"`
	Repository string `json:"repository"`
	Status     string `json:"status"`
}

type commandRunner interface {
	Run(context.Context, string, ...string) (string, error)
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Env = safeEnvironment(os.Environ())
	output, err := command.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if len(detail) > 2048 {
			detail = detail[len(detail)-2048:]
		}
		if detail != "" {
			return "", fmt.Errorf("%s: %s", err, detail)
		}
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func Materialize(ctx context.Context, request Request) (Result, error) {
	return materialize(ctx, request, execRunner{})
}

func materialize(ctx context.Context, request Request, runner commandRunner) (Result, error) {
	owner, project, err := validateRequest(request)
	if err != nil {
		return Result{}, err
	}
	root, err := filepath.Abs(request.WorktreesRoot)
	if err != nil {
		return Result{}, fmt.Errorf("resolve worktrees root: %w", err)
	}
	projectsRoot := filepath.Dir(root)
	basePath := filepath.Join(projectsRoot, project)
	targetPath := filepath.Join(root, project, filepath.FromSlash(request.Branch))
	if err := ensureContained(filepath.Join(root, project), targetPath); err != nil {
		return Result{}, err
	}
	if err := rejectSymlinkComponents(root, filepath.Dir(targetPath)); err != nil {
		return Result{}, err
	}
	if _, err := runner.Run(ctx, "git", "check-ref-format", "--branch", request.Branch); err != nil {
		return Result{}, errors.New("branch identity is not a valid Git branch")
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
		return Result{}, fmt.Errorf("create worktree parent: %w", err)
	}
	if err := rejectSymlinkComponents(root, filepath.Dir(targetPath)); err != nil {
		return Result{}, err
	}
	if err := ensureResolvedContained(filepath.Join(root, project), targetPath); err != nil {
		return Result{}, err
	}
	lockName := sha256.Sum256([]byte(request.Repository))
	lockPath := filepath.Join(root, ".locks", hex.EncodeToString(lockName[:])+".lock")
	if err := rejectSymlinkComponents(root, filepath.Dir(lockPath)); err != nil {
		return Result{}, err
	}
	if info, err := os.Lstat(lockPath); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return Result{}, errors.New("repository materialization lock must not be a symlink")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("inspect materialization lock: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return Result{}, fmt.Errorf("create materialization lock directory: %w", err)
	}
	if err := rejectSymlinkComponents(root, filepath.Dir(lockPath)); err != nil {
		return Result{}, err
	}
	guard := flock.New(lockPath)
	locked, err := guard.TryLockContext(ctx, 0)
	if err != nil {
		return Result{}, fmt.Errorf("lock repository materialization: %w", err)
	}
	if !locked {
		return Result{}, errors.New("repository materialization is already running")
	}
	defer guard.Unlock()

	remoteURL := "https://github.com/" + owner + "/" + project + ".git"
	cloned := false
	if info, statErr := os.Lstat(basePath); errors.Is(statErr, os.ErrNotExist) {
		if _, err := runner.Run(ctx, "git", "clone", "--origin", "origin", "--no-checkout", "--no-tags", remoteURL, basePath); err != nil {
			return Result{}, fmt.Errorf("clone repository: %w", err)
		}
		cloned = true
	} else if statErr != nil {
		return Result{}, fmt.Errorf("inspect repository path: %w", statErr)
	} else if info.Mode()&os.ModeSymlink != 0 {
		return Result{}, errors.New("project repository path must not be a symlink")
	}
	if err := verifyRepository(ctx, runner, basePath, remoteURL); err != nil {
		return Result{}, err
	}
	if _, err := runner.Run(ctx, "git", "-C", basePath, "config", "extensions.worktreeConfig", "true"); err != nil {
		return Result{}, fmt.Errorf("enable worktree-specific configuration: %w", err)
	}
	if cloned {
		if _, err := runner.Run(ctx, "git", "-C", basePath, "checkout", "--detach"); err != nil {
			return Result{}, fmt.Errorf("detach administrative project checkout: %w", err)
		}
	}
	if _, err := runner.Run(ctx, "git", "-C", basePath, "fetch", "--no-tags", "origin", "+refs/heads/"+request.Branch+":refs/remotes/origin/"+request.Branch); err != nil {
		return Result{}, fmt.Errorf("fetch approved branch: %w", err)
	}
	fetched, err := runner.Run(ctx, "git", "-C", basePath, "rev-parse", "--verify", "refs/remotes/origin/"+request.Branch+"^{commit}")
	if err != nil {
		return Result{}, fmt.Errorf("resolve approved branch: %w", err)
	}
	if fetched != request.Commit {
		return Result{}, fmt.Errorf("approved branch moved: expected %s, received %s", request.Commit, fetched)
	}
	if existing, ok, err := existingBranchWorktree(ctx, runner, basePath, request.Branch); err != nil {
		return Result{}, err
	} else if ok {
		if samePath(existing, basePath) {
			return Result{}, errors.New("approved branch is already checked out in the base project instead of its Project-managed path")
		}
		if err := verifyExisting(ctx, runner, existing, request.Commit, basePath, filepath.Join(root, project)); err != nil {
			return Result{}, err
		}
		return Result{Branch: request.Branch, Commit: request.Commit, Path: existing, Repository: request.Repository, Status: "ready"}, nil
	}
	if _, err := os.Lstat(targetPath); err == nil {
		return Result{}, fmt.Errorf("managed worktree path already exists: %s", targetPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("inspect managed worktree target: %w", err)
	}
	localRef := "refs/heads/" + request.Branch
	_, localErr := runner.Run(ctx, "git", "-C", basePath, "show-ref", "--verify", "--quiet", localRef)
	var addArgs []string
	if localErr == nil {
		localCommit, resolveErr := runner.Run(ctx, "git", "-C", basePath, "rev-parse", "--verify", localRef+"^{commit}")
		if resolveErr != nil || localCommit != request.Commit {
			return Result{}, errors.New("existing local branch does not match the approved commit")
		}
		addArgs = []string{"-C", basePath, "worktree", "add", targetPath, request.Branch}
	} else {
		addArgs = []string{"-C", basePath, "worktree", "add", "--track", "-b", request.Branch, targetPath, "origin/" + request.Branch}
	}
	if _, err := runner.Run(ctx, "git", addArgs...); err != nil {
		return Result{}, fmt.Errorf("create managed worktree: %w", err)
	}
	if err := verifyExisting(ctx, runner, targetPath, request.Commit, basePath, filepath.Join(root, project)); err != nil {
		return Result{}, err
	}
	return Result{Branch: request.Branch, Commit: request.Commit, Path: targetPath, Repository: request.Repository, Status: "created"}, nil
}

func rejectSymlinkComponents(root, target string) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("resolve managed root: %w", err)
	}
	target, err = filepath.Abs(target)
	if err != nil {
		return fmt.Errorf("resolve managed target: %w", err)
	}
	if err := ensureContained(filepath.Dir(root), target); err != nil {
		return err
	}
	current := root
	for {
		info, statErr := os.Lstat(current)
		if statErr == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed worktree path contains a symlink: %s", current)
		}
		if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			return fmt.Errorf("inspect managed path: %w", statErr)
		}
		if samePath(current, target) {
			return nil
		}
		relative, relErr := filepath.Rel(current, target)
		if relErr != nil || relative == "." || strings.HasPrefix(relative, "..") {
			return errors.New("managed worktree path containment changed")
		}
		next := strings.Split(relative, string(filepath.Separator))[0]
		current = filepath.Join(current, next)
	}
}

func validateRequest(request Request) (string, string, error) {
	parts := strings.Split(request.Repository, "/")
	if len(parts) != 2 || !repositoryPartPattern.MatchString(parts[0]) || !repositoryPartPattern.MatchString(parts[1]) || parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." {
		return "", "", errors.New("repository must be an exact GitHub owner/name identity")
	}
	if !commitPattern.MatchString(request.Commit) {
		return "", "", errors.New("commit must be a full lowercase hexadecimal object ID")
	}
	if request.WorktreesRoot == "" || filepath.Base(filepath.Clean(request.WorktreesRoot)) != ".worktrees" {
		return "", "", errors.New("worktrees root must end in .worktrees")
	}
	if err := validateBranch(request.Branch); err != nil {
		return "", "", err
	}
	return parts[0], parts[1], nil
}

func validateBranch(branch string) error {
	if strings.TrimSpace(branch) != branch || branch == "" || filepath.IsAbs(branch) || strings.Contains(branch, `\`) || strings.ContainsRune(branch, 0) {
		return errors.New("branch identity is unsafe for a managed worktree path")
	}
	for _, part := range strings.Split(branch, "/") {
		if part == "" || part == "." || part == ".." || part == ".git" {
			return errors.New("branch identity escapes or collides with the managed worktree path")
		}
	}
	return nil
}

func verifyRepository(ctx context.Context, runner commandRunner, basePath, remoteURL string) error {
	root, err := runner.Run(ctx, "git", "-C", basePath, "rev-parse", "--show-toplevel")
	if err != nil || !samePath(root, basePath) {
		return errors.New("project path is not the expected repository root")
	}
	remote, err := runner.Run(ctx, "git", "-C", basePath, "remote", "get-url", "origin")
	if err != nil || normalizeRemote(remote) != normalizeRemote(remoteURL) {
		return errors.New("project path belongs to a different repository")
	}
	return nil
}

func existingBranchWorktree(ctx context.Context, runner commandRunner, basePath, branch string) (string, bool, error) {
	body, err := runner.Run(ctx, "git", "-C", basePath, "worktree", "list", "--porcelain")
	if err != nil {
		return "", false, fmt.Errorf("list repository worktrees: %w", err)
	}
	var path string
	for _, line := range strings.Split(body, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			path = strings.TrimPrefix(line, "worktree ")
		case line == "branch refs/heads/"+branch:
			return path, true, nil
		}
	}
	return "", false, nil
}

func verifyExisting(ctx context.Context, runner commandRunner, path, commit, basePath, managedRoot string) error {
	if !samePath(path, basePath) {
		if err := ensureResolvedContained(managedRoot, path); err != nil {
			return errors.New("branch is already checked out outside its Project-managed path")
		}
	}
	head, err := runner.Run(ctx, "git", "-C", path, "rev-parse", "--verify", "HEAD")
	if err != nil || head != commit {
		return errors.New("existing branch worktree does not match the approved commit")
	}
	return nil
}

func ensureContained(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errors.New("worktree target escapes the Project-managed root")
	}
	return nil
}

func ensureResolvedContained(root, target string) error {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve managed root: %w", err)
	}
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if errors.Is(err, os.ErrNotExist) {
		resolvedParent, parentErr := filepath.EvalSymlinks(filepath.Dir(target))
		if parentErr != nil {
			return fmt.Errorf("resolve managed target parent: %w", parentErr)
		}
		resolvedTarget = filepath.Join(resolvedParent, filepath.Base(target))
	} else if err != nil {
		return fmt.Errorf("resolve managed target: %w", err)
	}
	return ensureContained(resolvedRoot, resolvedTarget)
}

func samePath(left, right string) bool {
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(leftAbs); err == nil {
		leftAbs = resolved
	}
	if resolved, err := filepath.EvalSymlinks(rightAbs); err == nil {
		rightAbs = resolved
	}
	return filepath.Clean(leftAbs) == filepath.Clean(rightAbs)
}

func normalizeRemote(value string) string {
	return strings.TrimSuffix(strings.TrimSpace(value), ".git")
}

func safeEnvironment(environment []string) []string {
	allowed := map[string]bool{"HOME": true, "LANG": true, "LC_ALL": true, "PATH": true, "SSH_AUTH_SOCK": true, "SYSTEMROOT": true, "TMP": true, "TMPDIR": true, "TEMP": true}
	result := make([]string, 0, len(allowed))
	for _, item := range environment {
		key, _, ok := strings.Cut(item, "=")
		if ok && allowed[strings.ToUpper(key)] {
			result = append(result, item)
		}
	}
	return result
}
