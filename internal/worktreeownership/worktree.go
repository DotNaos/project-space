package worktreeownership

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	ownerConfigKey   = "project.codexThreadId"
	managedConfigKey = "project.worktreeManaged"
	issueConfigKey   = "project.issueNumber"
	taskConfigKey    = "project.taskName"
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
	BaseRef   string `json:"baseRef"`
	Branch    string `json:"branch"`
	Issue     int    `json:"issue,omitempty"`
	Owner     string `json:"ownerThreadId"`
	Path      string `json:"path"`
	Project   string `json:"project"`
	Status    string `json:"status"`
	Task      string `json:"task,omitempty"`
	Worktrees string `json:"worktreesRoot"`
}

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

	repo, currentPath, err := inspectRepository(options.StartPath)
	if err != nil {
		return Result{}, err
	}
	if existing, ok := ownedWorktree(repo, options.ThreadID); ok {
		return resultFor(repo, existing, options, "ready"), nil
	}

	if _, err := git(repo.mainPath, "fetch", "--prune", "origin"); err != nil {
		return Result{}, fmt.Errorf("update %s: %w", repo.baseRef, err)
	}
	if _, err := git(currentPath, "config", "extensions.worktreeConfig", "true"); err != nil {
		return Result{}, fmt.Errorf("enable worktree-specific configuration: %w", err)
	}

	task := strings.TrimSpace(options.TaskName)
	branchPrefix := "task-"
	if options.IssueNumber > 0 {
		task = strings.TrimSpace(options.IssueTitle)
		branchPrefix = fmt.Sprintf("issue-%d-", options.IssueNumber)
	}
	baseBranch := branchPrefix + Slug(task)
	branch, targetPath, err := availableTarget(repo, baseBranch, options.ThreadID)
	if err != nil {
		return Result{}, err
	}
	if err := ensureInside(repo.worktreesRoot, targetPath); err != nil {
		return Result{}, err
	}
	if _, err := git(repo.mainPath, "worktree", "add", "-b", branch, targetPath, repo.baseRef); err != nil {
		return Result{}, fmt.Errorf("create worktree: %w", err)
	}

	if err := configureOwnership(targetPath, options.ThreadID, task, options.IssueNumber); err != nil {
		_, _ = git(repo.mainPath, "worktree", "remove", "--force", targetPath)
		_, _ = git(repo.mainPath, "branch", "-D", branch)
		return Result{}, err
	}
	created := worktree{branch: branch, path: targetPath}
	return resultFor(repo, created, options, "created"), nil
}

func Check(options CheckOptions) (Result, error) {
	if err := validateThreadID(options.ThreadID); err != nil {
		return Result{}, err
	}
	options.ThreadID = strings.TrimSpace(options.ThreadID)
	repo, currentPath, err := inspectRepository(options.StartPath)
	if err != nil {
		return Result{}, err
	}
	if samePath(currentPath, repo.mainPath) {
		return Result{}, errors.New("the main worktree is read-only for implementation; run project worktree prepare <task>")
	}
	branch, err := git(currentPath, "branch", "--show-current")
	if err != nil {
		return Result{}, fmt.Errorf("read current branch: %w", err)
	}
	branch = strings.TrimSpace(branch)
	if branch == "" || branch == repo.defaultBranch {
		return Result{}, errors.New("a dedicated non-main branch is required")
	}
	expectedPath := filepath.Join(repo.worktreesRoot, branch)
	if !samePath(currentPath, expectedPath) {
		return Result{}, fmt.Errorf("worktree must use the project standard path %s", expectedPath)
	}
	managed, _ := git(currentPath, "config", "--worktree", "--get", managedConfigKey)
	if strings.TrimSpace(managed) != "true" {
		return Result{}, errors.New("worktree is not managed by the Project CLI; prepare a new worktree instead of adopting it implicitly")
	}
	owner, _ := git(currentPath, "config", "--worktree", "--get", ownerConfigKey)
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return Result{}, errors.New("worktree has no Codex owner; prepare a new worktree")
	}
	if owner != options.ThreadID {
		return Result{}, fmt.Errorf("worktree belongs to Codex thread %s, not the current thread %s; prepare a new worktree", owner, options.ThreadID)
	}
	issue := readIssueNumber(currentPath)
	task, _ := git(currentPath, "config", "--worktree", "--get", taskConfigKey)
	return Result{
		BaseRef:   repo.baseRef,
		Branch:    branch,
		Issue:     issue,
		Owner:     owner,
		Path:      currentPath,
		Project:   repo.project,
		Status:    "ready",
		Task:      strings.TrimSpace(task),
		Worktrees: repo.worktreesRoot,
	}, nil
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
	mainPath := ""
	for _, entry := range entries {
		if entry.branch == defaultBranch {
			mainPath = entry.path
			break
		}
	}
	if mainPath == "" {
		return repository{}, "", fmt.Errorf("no worktree has the default branch %q checked out", defaultBranch)
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

func ownedWorktree(repo repository, threadID string) (worktree, bool) {
	for _, entry := range repo.worktrees {
		if samePath(entry.path, repo.mainPath) {
			continue
		}
		if entry.branch == "" || !samePath(entry.path, filepath.Join(repo.worktreesRoot, entry.branch)) {
			continue
		}
		managed, _ := git(entry.path, "config", "--worktree", "--get", managedConfigKey)
		owner, _ := git(entry.path, "config", "--worktree", "--get", ownerConfigKey)
		if strings.TrimSpace(managed) == "true" && strings.TrimSpace(owner) == threadID {
			return entry, true
		}
	}
	return worktree{}, false
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

func configureOwnership(path string, threadID string, task string, issue int) error {
	values := [][2]string{
		{managedConfigKey, "true"},
		{ownerConfigKey, threadID},
		{taskConfigKey, task},
	}
	if issue > 0 {
		values = append(values, [2]string{issueConfigKey, strconv.Itoa(issue)})
	}
	for _, value := range values {
		if _, err := git(path, "config", "--worktree", value[0], value[1]); err != nil {
			return fmt.Errorf("record worktree ownership: %w", err)
		}
	}
	return nil
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
