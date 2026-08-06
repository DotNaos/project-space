package worktreeownership

import (
	"errors"
	"fmt"
	"strings"
)

type RecoverOptions struct {
	ExpectedOwnerThreadID string
	ReplacementThreadID   string
	StartPath             string
}

// Recover replaces an orphaned Codex owner only when the caller names the
// exact existing owner and the managed worktree is still pristine.
func Recover(options RecoverOptions) (Result, error) {
	if err := validateThreadID(options.ExpectedOwnerThreadID); err != nil {
		return Result{}, fmt.Errorf("expected owner: %w", err)
	}
	if err := validateThreadID(options.ReplacementThreadID); err != nil {
		return Result{}, fmt.Errorf("replacement owner: %w", err)
	}
	expectedOwner := strings.TrimSpace(options.ExpectedOwnerThreadID)
	replacementOwner := strings.TrimSpace(options.ReplacementThreadID)
	if expectedOwner == replacementOwner {
		return Result{}, errors.New("replacement owner must differ from the expected owner")
	}

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
		managed, _, configErr := worktreeConfigValue(lockedPath, managedConfigKey)
		if configErr != nil {
			return configErr
		}
		if managed != "true" {
			return errors.New("only a Project-managed worktree can be recovered")
		}
		owner, _, configErr := worktreeConfigValue(lockedPath, ownerConfigKey)
		if configErr != nil {
			return configErr
		}
		if owner != expectedOwner {
			return errors.New("worktree owner no longer matches the expected orphaned owner")
		}
		if existing, ok, ownedErr := ownedWorktree(repo, replacementOwner); ownedErr != nil {
			return ownedErr
		} else if ok && !samePath(existing.path, lockedPath) {
			return alreadyOwnsWorktree(replacementOwner, existing.path, lockedPath)
		}
		if claimErr := ensureUnownedWorktreeClaimable(lockedPath, repo.baseRef, branch); claimErr != nil {
			return fmt.Errorf("recover owned worktree: %w", claimErr)
		}
		if _, configErr := git(
			lockedPath,
			"config",
			"--worktree",
			ownerConfigKey,
			replacementOwner,
		); configErr != nil {
			return fmt.Errorf("replace orphaned worktree ownership: %w", configErr)
		}
		confirmedOwner, _, configErr := worktreeConfigValue(lockedPath, ownerConfigKey)
		if configErr != nil {
			return configErr
		}
		if confirmedOwner != replacementOwner {
			return errors.New("worktree ownership changed while it was being recovered")
		}
		result = claimedResult(repo, lockedPath, branch, replacementOwner, "recovered")
		return nil
	})
	if err != nil {
		return Result{}, err
	}
	return result, nil
}
