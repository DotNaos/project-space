package worktreeownership

import (
	"fmt"
	"path/filepath"
	"strings"
)

// CheckoutContext describes the role boundary that follows from the current
// checkout. It is deliberately read-only: callers must use Prepare or Claim
// before doing implementation work.
type CheckoutContext struct {
	State           string `json:"state"`
	Role            string `json:"role"`
	Reason          string `json:"reason"`
	Repository      string `json:"repository"`
	Project         string `json:"project"`
	Path            string `json:"path"`
	Branch          string `json:"branch,omitempty"`
	DefaultBranch   string `json:"defaultBranch"`
	OwnerThreadID   string `json:"ownerThreadId,omitempty"`
	CurrentThreadID string `json:"currentThreadId,omitempty"`
	Issue           int    `json:"issue,omitempty"`
	Task            string `json:"task,omitempty"`
	WorkspaceID     string `json:"workspaceId,omitempty"`
	Managed         bool   `json:"managed"`
	MutatingAllowed bool   `json:"mutatingAllowed"`
}

// InspectContext classifies main, owned, foreign, and unmanaged checkouts
// without changing Git state or worktree configuration.
func InspectContext(startPath, threadID string) (CheckoutContext, error) {
	repo, currentPath, err := inspectRepository(startPath)
	if err != nil {
		return CheckoutContext{}, err
	}
	threadID = strings.TrimSpace(threadID)
	result := CheckoutContext{
		Repository:      repo.project,
		Project:         repo.project,
		Path:            currentPath,
		DefaultBranch:   repo.defaultBranch,
		CurrentThreadID: threadID,
		Role:            "observer",
		MutatingAllowed: false,
	}

	if samePath(currentPath, repo.mainPath) {
		result.State = "main"
		result.Role = "project-manager"
		result.Reason = "shared main checkout is read-only and routes the agent to the Project Manager role"
		return result, nil
	}

	branch, branchErr := git(currentPath, "branch", "--show-current")
	if branchErr != nil {
		return result, fmt.Errorf("read current branch: %w", branchErr)
	}
	result.Branch = strings.TrimSpace(branch)
	if result.Branch == "" {
		return unmanagedContext(result, "detached checkouts cannot establish an implementation role")
	}
	if !samePath(currentPath, filepath.Join(repo.worktreesRoot, result.Branch)) {
		return unmanagedContext(result, "checkout is outside the Project-managed worktree path")
	}

	managed, _, configErr := worktreeConfigValue(currentPath, managedConfigKey)
	if configErr != nil {
		return result, configErr
	}
	result.Managed = managed == "true"
	result.Issue = readIssueNumber(currentPath)
	result.Task = readTaskName(currentPath)
	result.WorkspaceID = readWorkspaceID(currentPath)
	owner, _, ownerErr := worktreeConfigValue(currentPath, ownerConfigKey)
	if ownerErr != nil {
		return result, ownerErr
	}
	result.OwnerThreadID = strings.TrimSpace(owner)
	if !result.Managed || result.OwnerThreadID == "" || !threadIDPattern.MatchString(result.OwnerThreadID) ||
		(result.WorkspaceID != "" && !threadIDPattern.MatchString(result.WorkspaceID)) {
		return unmanagedContext(result, "checkout does not have complete valid Project ownership metadata")
	}
	if result.OwnerThreadID == threadID {
		result.State = "owned"
		result.Role = "implementer"
		result.Reason = "current Codex task owns this Project-managed issue worktree"
		result.MutatingAllowed = true
		return result, nil
	}
	result.State = "foreign"
	result.Reason = "another Codex task owns this Project-managed worktree; implementation is non-mutating here"
	return result, nil
}

func unmanagedContext(result CheckoutContext, reason string) (CheckoutContext, error) {
	result.State = "unmanaged"
	result.Reason = reason
	result.Role = "observer"
	result.MutatingAllowed = false
	return result, nil
}
