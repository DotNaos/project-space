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
			if claimErr := ensureUnownedWorktreeClaimable(lockedPath, repo.baseRef); claimErr != nil {
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

func ensureUnownedWorktreeClaimable(path string, baseRef string) error {
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
	if strings.TrimSpace(head) != strings.TrimSpace(base) {
		return fmt.Errorf("unowned worktree HEAD does not match %s; create a fresh worktree from the current base instead of claiming commits with unclear ownership", baseRef)
	}
	return nil
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
