package worktreeownership

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type repository struct {
	baseRef       string
	defaultBranch string
	mainPath      string
	project       string
	worktrees     []worktree
	worktreesRoot string
}

type worktree struct {
	branch string
	path   string
}

func inspectRepository(startPath string) (repository, string, error) {
	if strings.TrimSpace(startPath) == "" {
		return repository{}, "", errors.New("start path is required")
	}
	root, err := git(startPath, "rev-parse", "--show-toplevel")
	if err != nil {
		return repository{}, "", fmt.Errorf("find repository: %w", err)
	}
	currentPath, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil {
		return repository{}, "", err
	}
	defaultBranch := defaultBranch(currentPath)
	entries, err := listWorktrees(currentPath)
	if err != nil {
		return repository{}, "", err
	}
	mainPath, err := mainWorktreePath(currentPath, entries)
	if err != nil {
		return repository{}, "", err
	}
	project := filepath.Base(mainPath)
	worktreesRoot := filepath.Join(filepath.Dir(mainPath), ".worktrees", project)
	return repository{
		baseRef:       "origin/" + defaultBranch,
		defaultBranch: defaultBranch,
		mainPath:      mainPath,
		project:       project,
		worktrees:     entries,
		worktreesRoot: worktreesRoot,
	}, currentPath, nil
}

func mainWorktreePath(currentPath string, entries []worktree) (string, error) {
	commonDirOutput, err := git(currentPath, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", fmt.Errorf("find main worktree: %w", err)
	}
	commonDir := strings.TrimSpace(commonDirOutput)
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(currentPath, commonDir)
	}
	commonDir, err = filepath.EvalSymlinks(commonDir)
	if err != nil {
		return "", fmt.Errorf("resolve main worktree Git directory: %w", err)
	}
	if filepath.Base(commonDir) != ".git" {
		return "", errors.New("repository uses an unsupported external Git directory")
	}
	mainPath := filepath.Dir(commonDir)
	for _, entry := range entries {
		if samePath(entry.path, mainPath) {
			return entry.path, nil
		}
	}
	return "", errors.New("main worktree is missing from the Git worktree list")
}

func defaultBranch(path string) string {
	ref, err := git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
	if err == nil {
		parts := strings.Split(strings.TrimSpace(ref), "/")
		if len(parts) > 1 && parts[len(parts)-1] != "" {
			return parts[len(parts)-1]
		}
	}
	return "main"
}

func listWorktrees(path string) ([]worktree, error) {
	output, err := git(path, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("list worktrees: %w", err)
	}
	var entries []worktree
	current := worktree{}
	for _, line := range strings.Split(output, "\n") {
		if line == "" {
			if current.path != "" {
				entries = append(entries, current)
				current = worktree{}
			}
			continue
		}
		if strings.HasPrefix(line, "worktree ") {
			current.path = strings.TrimPrefix(line, "worktree ")
		}
		if strings.HasPrefix(line, "branch refs/heads/") {
			current.branch = strings.TrimPrefix(line, "branch refs/heads/")
		}
	}
	if current.path != "" {
		entries = append(entries, current)
	}
	return entries, nil
}

func ownedWorktree(repo repository, threadID string) (worktree, bool, error) {
	matches := make([]worktree, 0, 1)
	for _, entry := range repo.worktrees {
		if samePath(entry.path, repo.mainPath) {
			continue
		}
		if entry.branch == "" || !samePath(entry.path, filepath.Join(repo.worktreesRoot, entry.branch)) {
			continue
		}
		owner, _, err := worktreeConfigValue(entry.path, ownerConfigKey)
		if err != nil {
			return worktree{}, false, err
		}
		if owner == threadID {
			matches = append(matches, entry)
		}
	}
	if len(matches) == 0 {
		return worktree{}, false, nil
	}
	if len(matches) > 1 {
		paths := make([]string, 0, len(matches))
		for _, match := range matches {
			paths = append(paths, match.path)
		}
		return worktree{}, false, fmt.Errorf(
			"Codex thread %s is assigned to multiple worktrees (%s); stop and repair ownership before continuing",
			threadID,
			strings.Join(paths, ", "),
		)
	}
	return matches[0], true, nil
}

func availableTarget(repo repository, baseBranch string, threadID string) (string, string, error) {
	candidates := []string{baseBranch, baseBranch + "-" + shortThreadID(threadID)}
	for index := 2; index <= 20; index++ {
		candidates = append(candidates, baseBranch+"-"+shortThreadID(threadID)+"-"+strconv.Itoa(index))
	}
	for _, branch := range candidates {
		path := filepath.Join(repo.worktreesRoot, branch)
		if branchExists(repo.mainPath, branch) || pathExists(path) {
			continue
		}
		return branch, path, nil
	}
	return "", "", errors.New("could not derive an unused branch and worktree path")
}

func ensureInside(parent string, child string) error {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return err
	}
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("worktree path %s is outside %s", child, parent)
	}
	return nil
}

func shortThreadID(threadID string) string {
	compact := strings.ReplaceAll(threadID, "-", "")
	if len(compact) <= 8 {
		return compact
	}
	return compact[len(compact)-8:]
}

func branchExists(path string, branch string) bool {
	for _, ref := range []string{"refs/heads/" + branch, "refs/remotes/origin/" + branch} {
		if _, err := git(path, "show-ref", "--verify", "--quiet", ref); err == nil {
			return true
		}
	}
	return false
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil || !os.IsNotExist(err)
}

func samePath(left string, right string) bool {
	leftPath, _ := filepath.Abs(left)
	rightPath, _ := filepath.Abs(right)
	return filepath.Clean(leftPath) == filepath.Clean(rightPath)
}

func git(path string, args ...string) (string, error) {
	command := exec.Command("git", append([]string{"-C", path}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}
	return string(output), nil
}
