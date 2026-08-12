package worktreeownership

import (
	"errors"
	"fmt"
	"strings"
)

type ClaimOptions struct {
	StartPath string
	ThreadID  string
}

type ExactClaimOptions struct {
	StartPath   string
	TaskName    string
	ThreadID    string
	WorkspaceID string
}

// ClaimExact finishes ownership for one server-materialized worktree using the
// server-issued immutable Workspace identity. It never creates or removes a
// checkout and refuses any conflicting ownership evidence.
func ClaimExact(options ExactClaimOptions) (Result, error) {
	if err := validateThreadID(options.ThreadID); err != nil {
		return Result{}, err
	}
	if !threadIDPattern.MatchString(strings.TrimSpace(options.WorkspaceID)) ||
		strings.TrimSpace(options.TaskName) == "" || strings.ContainsAny(options.TaskName, "\x00\r\n") {
		return Result{}, errors.New("exact worktree ownership is invalid")
	}
	options.ThreadID = strings.TrimSpace(options.ThreadID)
	options.WorkspaceID = strings.TrimSpace(options.WorkspaceID)
	result := Result{}
	err := withOwnershipLock(options.StartPath, func() error {
		repo, path, err := inspectRepository(options.StartPath)
		if err != nil {
			return err
		}
		branch, err := validateDedicatedWorktree(repo, path)
		if err != nil {
			return err
		}
		owner, _, err := worktreeConfigValue(path, ownerConfigKey)
		if err != nil {
			return err
		}
		workspaceID, _, err := worktreeConfigValue(path, workspaceConfigKey)
		if err != nil {
			return err
		}
		managed, _, err := worktreeConfigValue(path, managedConfigKey)
		if err != nil {
			return err
		}
		task, _, err := worktreeConfigValue(path, taskConfigKey)
		if err != nil {
			return err
		}
		if owner != "" && owner != options.ThreadID ||
			workspaceID != "" && workspaceID != options.WorkspaceID ||
			managed != "" && managed != "true" ||
			task != "" && task != strings.TrimSpace(options.TaskName) ||
			managed == "true" && (owner == "" || workspaceID == "") {
			return errors.New("materialized worktree ownership changed")
		}
		if owner == options.ThreadID && workspaceID == options.WorkspaceID && managed == "true" {
			result = claimedResult(repo, path, branch, owner, "ready")
			result.WorkspaceID = workspaceID
			return nil
		}
		if err := ensureUnownedWorktreeClaimable(path, repo.baseRef, branch); err != nil {
			return err
		}
		if _, err := git(path, "config", "extensions.worktreeConfig", "true"); err != nil {
			return fmt.Errorf("enable worktree-specific configuration: %w", err)
		}
		values := [][2]string{{taskConfigKey, strings.TrimSpace(options.TaskName)},
			{workspaceConfigKey, options.WorkspaceID}, {ownerConfigKey, options.ThreadID}, {managedConfigKey, "true"}}
		for _, value := range values {
			if _, err := git(path, "config", "--worktree", value[0], value[1]); err != nil {
				return fmt.Errorf("record exact worktree ownership: %w", err)
			}
		}
		result = claimedResult(repo, path, branch, options.ThreadID, "claimed")
		result.WorkspaceID = options.WorkspaceID
		return nil
	})
	return result, err
}

func Claim(options ClaimOptions) (Result, error) {
	if err := validateThreadID(options.ThreadID); err != nil {
		return Result{}, err
	}
	options.ThreadID = strings.TrimSpace(options.ThreadID)
	initialRepo, currentPath, err := inspectRepository(options.StartPath)
	if err != nil {
		return Result{}, err
	}
	if _, err := validateDedicatedWorktree(initialRepo, currentPath); err != nil {
		return Result{}, err
	}

	result := Result{}
	err = withOwnershipLock(currentPath, func() error {
		repo, lockedPath, inspectErr := inspectRepository(currentPath)
		if inspectErr != nil {
			return inspectErr
		}
		branch, validateErr := validateDedicatedWorktree(repo, lockedPath)
		if validateErr != nil {
			return validateErr
		}
		existing, ok, ownedErr := ownedWorktree(repo, options.ThreadID)
		if ownedErr != nil {
			return ownedErr
		}
		if ok && !samePath(existing.path, lockedPath) {
			return alreadyOwnsWorktree(options.ThreadID, existing.path, lockedPath)
		}

		owner, _, configErr := worktreeConfigValue(lockedPath, ownerConfigKey)
		if configErr != nil {
			return configErr
		}
		managed, _, configErr := worktreeConfigValue(lockedPath, managedConfigKey)
		if configErr != nil {
			return configErr
		}
		if owner != "" && owner != options.ThreadID {
			return ownerConflict(owner, options.ThreadID)
		}
		if owner == options.ThreadID && managed == "true" {
			result = claimedResult(repo, lockedPath, branch, owner, "ready")
			return nil
		}
		if owner == "" {
			if claimErr := ensureUnownedWorktreeClaimable(lockedPath, repo.baseRef, branch); claimErr != nil {
				return claimErr
			}
		}
		if _, configErr := git(lockedPath, "config", "extensions.worktreeConfig", "true"); configErr != nil {
			return fmt.Errorf("enable worktree-specific configuration: %w", configErr)
		}
		if readTaskName(lockedPath) == "" {
			if _, configErr := git(lockedPath, "config", "--worktree", taskConfigKey, branch); configErr != nil {
				return fmt.Errorf("record worktree task: %w", configErr)
			}
		}
		if owner == "" {
			if _, configErr := git(lockedPath, "config", "--worktree", ownerConfigKey, options.ThreadID); configErr != nil {
				return fmt.Errorf("record worktree ownership: %w", configErr)
			}
		}
		if _, configErr := git(lockedPath, "config", "--worktree", managedConfigKey, "true"); configErr != nil {
			return fmt.Errorf("mark worktree as Project-managed: %w", configErr)
		}
		confirmedOwner, _, configErr := worktreeConfigValue(lockedPath, ownerConfigKey)
		if configErr != nil {
			return configErr
		}
		confirmedManaged, _, configErr := worktreeConfigValue(lockedPath, managedConfigKey)
		if configErr != nil {
			return configErr
		}
		if confirmedOwner != options.ThreadID || confirmedManaged != "true" {
			return errors.New("worktree ownership changed while it was being claimed; create a fresh worktree")
		}
		result = claimedResult(repo, lockedPath, branch, options.ThreadID, "claimed")
		return nil
	})
	if err != nil {
		return Result{}, err
	}
	return result, nil
}

func ensureUnownedWorktreeClaimable(path string, baseRef string, branch string) error {
	status, err := git(path, "status", "--porcelain")
	if err != nil {
		return fmt.Errorf("inspect unowned worktree: %w", err)
	}
	if strings.TrimSpace(status) != "" {
		return errors.New("unowned worktree contains changes; create a fresh worktree instead of claiming changes with unclear ownership")
	}
	head, err := git(path, "rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("inspect unowned worktree HEAD: %w", err)
	}
	base, err := git(path, "rev-parse", baseRef)
	if err != nil {
		return fmt.Errorf("inspect unowned worktree base %s: %w", baseRef, err)
	}
	if strings.TrimSpace(head) == strings.TrimSpace(base) {
		return nil
	}
	remoteBranch := "refs/remotes/origin/" + branch
	remote, remoteErr := git(path, "rev-parse", "--verify", remoteBranch)
	if remoteErr == nil && strings.TrimSpace(head) == strings.TrimSpace(remote) {
		return nil
	}
	return fmt.Errorf("unowned worktree HEAD does not match %s or %s; create a fresh worktree from an approved remote branch instead of claiming commits with unclear ownership", baseRef, remoteBranch)
}

func claimedResult(repo repository, path string, branch string, owner string, status string) Result {
	return Result{
		BaseRef:   repo.baseRef,
		Branch:    branch,
		Issue:     readIssueNumber(path),
		Owner:     owner,
		Path:      path,
		Project:   repo.project,
		Status:    status,
		Task:      readTaskName(path),
		Worktrees: repo.worktreesRoot,
	}
}

func readTaskName(path string) string {
	task, _ := git(path, "config", "--worktree", "--get", taskConfigKey)
	return strings.TrimSpace(task)
}

func ownerConflict(owner string, current string) error {
	return fmt.Errorf(
		"worktree belongs to Codex thread %s, not the current thread %s; prepare a new worktree",
		owner,
		current,
	)
}

func alreadyOwnsWorktree(threadID string, existingPath string, requestedPath string) error {
	return fmt.Errorf(
		"Codex thread %s already owns worktree %s; continue there instead of claiming %s",
		threadID,
		existingPath,
		requestedPath,
	)
}
