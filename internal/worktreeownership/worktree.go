package worktreeownership

import (
	"crypto/rand"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	ownerConfigKey     = "project.codexThreadId"
	managedConfigKey   = "project.worktreeManaged"
	issueConfigKey     = "project.issueNumber"
	taskConfigKey      = "project.taskName"
	workspaceConfigKey = "project.workspaceId"
)

var (
	nonSlugCharacters = regexp.MustCompile(`[^a-z0-9]+`)
	threadIDPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type PrepareOptions struct {
	IssueNumber int
	IssueTitle  string
	StartPath   string
	TaskName    string
	ThreadID    string
}

type CheckOptions struct {
	StartPath string
	ThreadID  string
}

type Result struct {
	BaseRef     string `json:"baseRef"`
	Branch      string `json:"branch"`
	Issue       int    `json:"issue,omitempty"`
	Owner       string `json:"ownerThreadId"`
	Path        string `json:"path"`
	Project     string `json:"project"`
	Status      string `json:"status"`
	Task        string `json:"task,omitempty"`
	Worktrees   string `json:"worktreesRoot"`
	WorkspaceID string `json:"workspaceId"`
}

// InspectManaged verifies the Project-managed linked-worktree boundary without
// requiring the caller to own the checkout. Runtime control uses this read-only
// form on the target host, where the originating Codex thread is not present.
func InspectManaged(startPath string) (Result, error) {
	repo, currentPath, err := inspectRepository(startPath)
	if err != nil {
		return Result{}, err
	}
	branch, err := validateDedicatedWorktree(repo, currentPath)
	if err != nil {
		return Result{}, err
	}
	managed, _, err := worktreeConfigValue(currentPath, managedConfigKey)
	if err != nil {
		return Result{}, err
	}
	if managed != "true" {
		return Result{}, errors.New("worktree is not managed by the Project CLI")
	}
	owner, _, err := worktreeConfigValue(currentPath, ownerConfigKey)
	if err != nil {
		return Result{}, err
	}
	if err := validateThreadID(owner); err != nil {
		return Result{}, fmt.Errorf("worktree has an invalid Codex owner: %w", err)
	}
	workspaceID, _, err := worktreeConfigValue(currentPath, workspaceConfigKey)
	if err != nil || !threadIDPattern.MatchString(strings.TrimSpace(workspaceID)) {
		return Result{}, errors.New("worktree has no valid immutable Workspace ID; run project worktree prepare here")
	}
	return Result{
		BaseRef: repo.baseRef, Branch: branch, Issue: readIssueNumber(currentPath),
		Owner: strings.TrimSpace(owner), Path: currentPath, Project: repo.project,
		Status: "ready", Task: readTaskName(currentPath), Worktrees: repo.worktreesRoot,
		WorkspaceID: strings.TrimSpace(workspaceID),
	}, nil
}

func Prepare(options PrepareOptions) (Result, error) {
	if err := validateThreadID(options.ThreadID); err != nil {
		return Result{}, err
	}
	options.ThreadID = strings.TrimSpace(options.ThreadID)
	if options.IssueNumber <= 0 && strings.TrimSpace(options.TaskName) == "" {
		return Result{}, errors.New("task name is required when no issue is provided")
	}
	if options.IssueNumber > 0 && strings.TrimSpace(options.IssueTitle) == "" {
		return Result{}, errors.New("issue title is required when an issue is provided")
	}

	_, currentPath, err := inspectRepository(options.StartPath)
	if err != nil {
		return Result{}, err
	}
	result := Result{}
	err = withOwnershipLock(currentPath, func() error {
		repo, _, inspectErr := inspectRepository(currentPath)
		if inspectErr != nil {
			return inspectErr
		}
		existing, ok, ownedErr := ownedWorktree(repo, options.ThreadID)
		if ownedErr != nil {
			return ownedErr
		}
		if ok {
			workspaceID, workspaceErr := ensureWorkspaceID(existing.path)
			if workspaceErr != nil {
				return workspaceErr
			}
			managed, _, configErr := worktreeConfigValue(existing.path, managedConfigKey)
			if configErr != nil {
				return configErr
			}
			if managed != "true" {
				if _, configErr := git(repo.mainPath, "config", "extensions.worktreeConfig", "true"); configErr != nil {
					return fmt.Errorf("enable worktree-specific configuration: %w", configErr)
				}
				if readTaskName(existing.path) == "" {
					if _, configErr := git(existing.path, "config", "--worktree", taskConfigKey, existing.branch); configErr != nil {
						return fmt.Errorf("record worktree task: %w", configErr)
					}
				}
				if _, configErr := git(existing.path, "config", "--worktree", managedConfigKey, "true"); configErr != nil {
					return fmt.Errorf("finish worktree ownership: %w", configErr)
				}
			}
			result = resultFor(repo, existing, options, "ready")
			result.WorkspaceID = workspaceID
			return nil
		}

		if _, fetchErr := git(repo.mainPath, "fetch", "--prune", "origin"); fetchErr != nil {
			return fmt.Errorf("update %s: %w", repo.baseRef, fetchErr)
		}
		if _, configErr := git(repo.mainPath, "config", "extensions.worktreeConfig", "true"); configErr != nil {
			return fmt.Errorf("enable worktree-specific configuration: %w", configErr)
		}

		task := strings.TrimSpace(options.TaskName)
		branchPrefix := "task-"
		if options.IssueNumber > 0 {
			task = strings.TrimSpace(options.IssueTitle)
			branchPrefix = fmt.Sprintf("issue-%d-", options.IssueNumber)
		}
		branch, targetPath, targetErr := availableTarget(repo, branchPrefix+Slug(task), options.ThreadID)
		if targetErr != nil {
			return targetErr
		}
		if insideErr := ensureInside(repo.worktreesRoot, targetPath); insideErr != nil {
			return insideErr
		}
		if _, addErr := git(repo.mainPath, "worktree", "add", "-b", branch, targetPath, repo.baseRef); addErr != nil {
			return fmt.Errorf("create worktree: %w", addErr)
		}

		createdRepo, createdPath, createdErr := inspectRepository(targetPath)
		if createdErr != nil {
			return cleanupCreatedWorktree(repo, targetPath, branch, options.ThreadID, createdErr)
		}
		if _, validateErr := validateDedicatedWorktree(createdRepo, createdPath); validateErr != nil {
			return cleanupCreatedWorktree(repo, targetPath, branch, options.ThreadID, validateErr)
		}
		if configureErr := configureOwnership(createdPath, options.ThreadID, task, options.IssueNumber); configureErr != nil {
			return cleanupCreatedWorktree(repo, targetPath, branch, options.ThreadID, configureErr)
		}
		result = resultFor(createdRepo, worktree{branch: branch, path: createdPath}, options, "created")
		result.WorkspaceID, _, _ = worktreeConfigValue(createdPath, workspaceConfigKey)
		return nil
	})
	if err != nil {
		return Result{}, err
	}
	return result, nil
}

func Check(options CheckOptions) (Result, error) {
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
		managed, _, configErr := worktreeConfigValue(lockedPath, managedConfigKey)
		if configErr != nil {
			return configErr
		}
		if managed != "true" {
			return errors.New("worktree is not managed by the Project CLI; run project worktree prepare here to claim it")
		}
		owner, _, configErr := worktreeConfigValue(lockedPath, ownerConfigKey)
		if configErr != nil {
			return configErr
		}
		if owner == "" {
			return errors.New("worktree has no Codex owner; run project worktree prepare here to claim it")
		}
		if owner != options.ThreadID {
			return ownerConflict(owner, options.ThreadID)
		}
		existing, ok, ownedErr := ownedWorktree(repo, options.ThreadID)
		if ownedErr != nil {
			return ownedErr
		}
		if !ok || !samePath(existing.path, lockedPath) {
			return errors.New("worktree ownership could not be confirmed; run project worktree prepare before continuing")
		}
		result = Result{
			BaseRef:     repo.baseRef,
			Branch:      branch,
			Issue:       readIssueNumber(lockedPath),
			Owner:       owner,
			Path:        lockedPath,
			Project:     repo.project,
			Status:      "ready",
			Task:        readTaskName(lockedPath),
			Worktrees:   repo.worktreesRoot,
			WorkspaceID: readWorkspaceID(lockedPath),
		}
		return nil
	})
	if err != nil {
		return Result{}, err
	}
	return result, nil
}

func validateDedicatedWorktree(repo repository, currentPath string) (string, error) {
	if samePath(currentPath, repo.mainPath) {
		return "", errors.New("the main worktree is read-only for implementation; run project worktree prepare <task>")
	}
	branch, err := git(currentPath, "branch", "--show-current")
	if err != nil {
		return "", fmt.Errorf("read current branch: %w", err)
	}
	branch = strings.TrimSpace(branch)
	if branch == "" || branch == repo.defaultBranch {
		return "", errors.New("a dedicated non-main branch is required")
	}
	expectedPath := filepath.Join(repo.worktreesRoot, branch)
	if !samePath(currentPath, expectedPath) {
		return "", fmt.Errorf("worktree must use the project standard path %s", expectedPath)
	}
	return branch, nil
}

func Slug(value string) string {
	slug := nonSlugCharacters.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "work"
	}
	if len(slug) > 56 {
		slug = strings.TrimRight(slug[:56], "-")
	}
	return slug
}

func configureOwnership(path string, threadID string, task string, issue int) error {
	workspaceID, err := newWorkspaceID()
	if err != nil {
		return err
	}
	values := [][2]string{
		{taskConfigKey, task},
		{workspaceConfigKey, workspaceID},
	}
	if issue > 0 {
		values = append(values, [2]string{issueConfigKey, strconv.Itoa(issue)})
	}
	values = append(values, [2]string{ownerConfigKey, threadID})
	values = append(values, [2]string{managedConfigKey, "true"})
	for _, value := range values {
		if _, err := git(path, "config", "--worktree", value[0], value[1]); err != nil {
			return fmt.Errorf("record worktree ownership: %w", err)
		}
	}
	return nil
}

func ensureWorkspaceID(path string) (string, error) {
	value, _, err := worktreeConfigValue(path, workspaceConfigKey)
	if err != nil {
		return "", err
	}
	value = strings.TrimSpace(value)
	if value != "" {
		if !threadIDPattern.MatchString(value) {
			return "", errors.New("worktree has an invalid immutable Workspace ID")
		}
		return value, nil
	}
	value, err = newWorkspaceID()
	if err != nil {
		return "", err
	}
	if _, err := git(path, "config", "--worktree", workspaceConfigKey, value); err != nil {
		return "", fmt.Errorf("record immutable Workspace ID: %w", err)
	}
	return value, nil
}

func readWorkspaceID(path string) string {
	value, _, _ := worktreeConfigValue(path, workspaceConfigKey)
	return strings.TrimSpace(value)
}

func newWorkspaceID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate immutable Workspace ID: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func cleanupCreatedWorktree(repo repository, targetPath string, branch string, threadID string, cause error) error {
	preserve := func(reason string) error {
		return fmt.Errorf("%w; preserving newly created worktree %s because %s", cause, targetPath, reason)
	}
	if !samePath(targetPath, filepath.Join(repo.worktreesRoot, branch)) {
		return preserve("its path no longer matches the expected branch")
	}
	actualBranch, err := git(targetPath, "branch", "--show-current")
	if err != nil || strings.TrimSpace(actualBranch) != branch {
		return preserve("its checked-out branch changed")
	}
	status, err := git(targetPath, "status", "--porcelain")
	if err != nil || strings.TrimSpace(status) != "" {
		return preserve("it contains changes")
	}
	head, headErr := git(targetPath, "rev-parse", "HEAD")
	base, baseErr := git(repo.mainPath, "rev-parse", repo.baseRef)
	if headErr != nil || baseErr != nil || strings.TrimSpace(head) != strings.TrimSpace(base) {
		return preserve("its commit no longer matches the prepared base")
	}
	owner, _, configErr := worktreeConfigValue(targetPath, ownerConfigKey)
	if configErr != nil {
		return preserve("its ownership configuration cannot be read")
	}
	managed, _, configErr := worktreeConfigValue(targetPath, managedConfigKey)
	if configErr != nil {
		return preserve("its ownership configuration cannot be read")
	}
	if owner != "" && owner != threadID {
		return preserve("another Codex thread owns it")
	}
	if managed == "true" {
		return preserve("its ownership setup already completed")
	}
	if _, err := git(repo.mainPath, "worktree", "remove", targetPath); err != nil {
		return fmt.Errorf("%w (also failed to remove unused worktree %s: %v)", cause, targetPath, err)
	}
	if _, err := git(repo.mainPath, "update-ref", "-d", "refs/heads/"+branch, strings.TrimSpace(head)); err != nil {
		return fmt.Errorf("%w (also preserved branch %s because it changed during cleanup: %v)", cause, branch, err)
	}
	return cause
}

func resultFor(repo repository, entry worktree, options PrepareOptions, status string) Result {
	issue := options.IssueNumber
	task := strings.TrimSpace(options.TaskName)
	if status == "ready" {
		issue = readIssueNumber(entry.path)
		task, _ = git(entry.path, "config", "--worktree", "--get", taskConfigKey)
		task = strings.TrimSpace(task)
	} else if issue > 0 {
		task = strings.TrimSpace(options.IssueTitle)
	}
	return Result{
		BaseRef:   repo.baseRef,
		Branch:    entry.branch,
		Issue:     issue,
		Owner:     options.ThreadID,
		Path:      entry.path,
		Project:   repo.project,
		Status:    status,
		Task:      task,
		Worktrees: repo.worktreesRoot,
	}
}

func readIssueNumber(path string) int {
	value, _ := git(path, "config", "--worktree", "--get", issueConfigKey)
	issue, _ := strconv.Atoi(strings.TrimSpace(value))
	return issue
}

func validateThreadID(threadID string) error {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return errors.New("CODEX_THREAD_ID is not set; start or continue a Codex chat before preparing a worktree")
	}
	if !threadIDPattern.MatchString(threadID) {
		return errors.New("CODEX_THREAD_ID is not a valid Codex thread identifier")
	}
	return nil
}
