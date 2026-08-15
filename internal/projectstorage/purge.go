package projectstorage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const purgeLockTimeout = 2 * time.Minute

var worktreeIDPattern = regexp.MustCompile(`^wt_[a-f0-9]{24}$`)
var headPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

type Blocker struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Evidence struct {
	Code          string `json:"code"`
	Message       string `json:"message"`
	PullRequest   int    `json:"pullRequest,omitempty"`
	RecoveryState string `json:"recoveryState,omitempty"`
	URL           string `json:"url,omitempty"`
}

type EvidenceResult struct {
	Blockers []Blocker
	Evidence []Evidence
}

type PurgeCandidate struct {
	Branch        string `json:"branch"`
	Bytes         int64  `json:"bytes"`
	HeadSHA       string `json:"headSha"`
	OwnerThreadID string `json:"ownerThreadId"`
	Path          string `json:"path"`
	ProjectID     string `json:"projectId"`
	Repository    string `json:"repository"`
	WorktreeID    string `json:"worktreeId"`
}

type PurgePlan struct {
	Blockers      []Blocker       `json:"blockers"`
	Candidate     *PurgeCandidate `json:"candidate,omitempty"`
	CheckedAt     string          `json:"checkedAt"`
	Evidence      []Evidence      `json:"evidence,omitempty"`
	Purgeable     bool            `json:"purgeable"`
	SchemaVersion int             `json:"schemaVersion"`
}

type PurgeResult struct {
	CheckedAt            string     `json:"checkedAt"`
	FreeSpaceDeltaBytes  int64      `json:"freeSpaceDeltaBytes,omitempty"`
	FreeSpaceError       string     `json:"freeSpaceError,omitempty"`
	FreeSpaceMeasured    bool       `json:"freeSpaceMeasured"`
	HeadSHA              string     `json:"headSha"`
	MeasuredBytesRemoved int64      `json:"measuredBytesRemoved"`
	Path                 string     `json:"path"`
	Evidence             []Evidence `json:"evidence,omitempty"`
	SchemaVersion        int        `json:"schemaVersion"`
	State                string     `json:"state"`
	Verified             bool       `json:"verified"`
	WorktreeID           string     `json:"worktreeId"`
}

type EvidenceCheck func(context.Context, PurgeCandidate) (EvidenceResult, error)

type PurgeOptions struct {
	Checks []EvidenceCheck
	Meter  Meter
	Now    func() time.Time
}

func PlanWorktreePurge(
	ctx context.Context,
	projectID, repository, projectPath, targetID string,
	options PurgeOptions,
) (PurgePlan, error) {
	if !worktreeIDPattern.MatchString(targetID) {
		return PurgePlan{}, errors.New("worktree ID is invalid")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	report, err := Audit(ctx, projectID, repository, projectPath, Options{Meter: zeroMeter, Now: now})
	if err != nil {
		return PurgePlan{}, err
	}
	var target *Entry
	for index := range report.Worktrees {
		if report.Worktrees[index].ID == targetID {
			target = &report.Worktrees[index]
			break
		}
	}
	if target == nil {
		return PurgePlan{}, errors.New("registered worktree was not found")
	}
	return planWorktreeEntry(ctx, projectID, repository, report.Path, *target, now, options), nil
}

func planWorktreeEntry(
	ctx context.Context,
	projectID, repository, mainPath string,
	target Entry,
	now func() time.Time,
	options PurgeOptions,
) PurgePlan {
	plan := PurgePlan{
		Blockers: make([]Blocker, 0), CheckedAt: now().UTC().Format(time.RFC3339Nano), SchemaVersion: 1,
	}
	var err error
	target.Bytes, err = measureOne(ctx, target.Path, options.Meter)
	if err != nil {
		target.SizeState = "unavailable"
		target.Error = err.Error()
	} else {
		target.SizeState = "measured"
	}
	candidate := PurgeCandidate{
		Branch: target.Branch, Bytes: target.Bytes, HeadSHA: target.HeadSHA,
		Path: target.Path, ProjectID: projectID, Repository: repository, WorktreeID: target.ID,
	}
	plan.Candidate = &candidate
	if target.IsMain {
		plan.Blockers = append(plan.Blockers, blocker("main_checkout", "The main checkout requires the stronger checkout purge workflow."))
	}
	if target.Kind != "project-managed" {
		plan.Blockers = append(plan.Blockers, blocker("ownership_boundary", "Only Project-managed worktrees can be purged by this command."))
	}
	if target.SizeState != "measured" {
		plan.Blockers = append(plan.Blockers, blocker("storage_unavailable", "The worktree storage measurement is incomplete."))
	}
	if !headPattern.MatchString(target.HeadSHA) || strings.TrimSpace(target.Branch) == "" {
		plan.Blockers = append(plan.Blockers, blocker("git_identity", "Git did not provide a stable branch and head commit."))
	}
	if !target.IsMain && target.Kind == "project-managed" {
		owner, localBlockers := localWorktreeBlockers(ctx, mainPath, target)
		candidate.OwnerThreadID = owner
		plan.Candidate = &candidate
		plan.Blockers = append(plan.Blockers, localBlockers...)
	}
	if len(plan.Blockers) == 0 {
		for _, check := range options.Checks {
			if check == nil || plan.Candidate == nil {
				continue
			}
			result, checkErr := check(ctx, *plan.Candidate)
			if checkErr != nil {
				plan.Blockers = append(plan.Blockers, blocker("evidence_unavailable", checkErr.Error()))
				continue
			}
			plan.Blockers = append(plan.Blockers, result.Blockers...)
			plan.Evidence = append(plan.Evidence, result.Evidence...)
		}
	}
	plan.Purgeable = len(plan.Blockers) == 0
	return plan
}

func PurgeWorktree(
	ctx context.Context,
	projectID, repository, projectPath, targetID, expectedHead string,
	options PurgeOptions,
) (PurgeResult, error) {
	if len(options.Checks) < 3 {
		return PurgeResult{}, errors.New("worktree purge safety checks are unavailable")
	}
	if !headPattern.MatchString(expectedHead) {
		return PurgeResult{}, errors.New("--expect-head must be the exact full worktree commit")
	}
	commonDir, err := git(ctx, projectPath, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return PurgeResult{}, err
	}
	lockPath := filepath.Join(strings.TrimSpace(commonDir), "project-space", "worktree-purge.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return PurgeResult{}, fmt.Errorf("create worktree purge lock: %w", err)
	}
	fileLock := flock.New(lockPath, flock.SetPermissions(0o600))
	lockContext, cancel := context.WithTimeout(ctx, purgeLockTimeout)
	defer cancel()
	locked, err := fileLock.TryLockContext(lockContext, 25*time.Millisecond)
	if err != nil || !locked {
		return PurgeResult{}, errors.New("another worktree purge operation is active")
	}
	defer fileLock.Unlock()

	plan, err := PlanWorktreePurge(ctx, projectID, repository, projectPath, targetID, options)
	if err != nil {
		return PurgeResult{}, err
	}
	if plan.Candidate == nil || plan.Candidate.HeadSHA != expectedHead {
		return PurgeResult{}, errors.New("worktree head changed after review")
	}
	if !plan.Purgeable {
		return PurgeResult{}, fmt.Errorf("worktree is blocked: %s", summarizeBlockers(plan.Blockers))
	}
	freeBefore, freeBeforeErr := diskFreeBytes(plan.Candidate.Path)
	if _, err := git(ctx, plan.Candidate.Path, "worktree", "remove", plan.Candidate.Path); err != nil {
		return PurgeResult{}, fmt.Errorf("remove worktree without force: %w", err)
	}
	if _, err := os.Lstat(plan.Candidate.Path); !os.IsNotExist(err) {
		return PurgeResult{}, errors.New("worktree path still exists after Git reported removal")
	}
	verification, err := Audit(ctx, projectID, repository, projectPath, Options{
		Meter: zeroMeter, Now: options.Now,
	})
	if err != nil {
		return PurgeResult{}, fmt.Errorf("verify worktree removal: %w", err)
	}
	for _, entry := range verification.Worktrees {
		if entry.ID == targetID {
			return PurgeResult{}, errors.New("worktree registration still exists after removal")
		}
	}
	result := PurgeResult{
		CheckedAt: plan.CheckedAt, HeadSHA: expectedHead,
		MeasuredBytesRemoved: plan.Candidate.Bytes, Path: plan.Candidate.Path, Evidence: plan.Evidence,
		SchemaVersion: 1, State: "purged", Verified: true, WorktreeID: targetID,
	}
	freeAfter, freeAfterErr := diskFreeBytes(filepath.Dir(plan.Candidate.Path))
	if freeBeforeErr == nil && freeAfterErr == nil {
		result.FreeSpaceDeltaBytes = freeAfter - freeBefore
		result.FreeSpaceMeasured = true
	} else {
		result.FreeSpaceError = "free-space delta could not be measured"
	}
	return result, nil
}

func localWorktreeBlockers(ctx context.Context, mainPath string, target Entry) (string, []Blocker) {
	blockers := make([]Blocker, 0)
	managed, managedErr := git(ctx, target.Path, "config", "--worktree", "--get", "project.worktreeManaged")
	if managedErr != nil || strings.TrimSpace(managed) != "true" {
		blockers = append(blockers, blocker("not_project_managed", "The worktree is not marked as managed by the Project CLI."))
	}
	owner, ownerErr := git(ctx, target.Path, "config", "--worktree", "--get", "project.codexThreadId")
	owner = strings.TrimSpace(owner)
	if ownerErr != nil || owner == "" {
		blockers = append(blockers, blocker("owner_unknown", "The owning Codex task is unknown."))
	}
	status, statusErr := git(ctx, target.Path, "status", "--porcelain=v2", "--untracked-files=all", "--ignored=matching")
	if statusErr != nil {
		blockers = append(blockers, blocker("git_status_unavailable", "Git working state could not be inspected."))
	} else {
		blockers = append(blockers, statusBlockers(status)...)
	}
	blockers = append(blockers, gitOperationBlockers(ctx, target.Path)...)
	if !inside(filepath.Join(filepath.Dir(mainPath), ".worktrees", filepath.Base(mainPath)), target.Path) {
		blockers = append(blockers, blocker("path_scope", "The worktree path is outside the Project-managed root."))
	}
	return owner, blockers
}

func statusBlockers(output string) []Blocker {
	blockers := make([]Blocker, 0)
	ignored := make([]string, 0)
	untracked, working := false, false
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "! ") {
			path := strings.TrimSpace(strings.TrimPrefix(line, "! "))
			if disposableIgnoredPath(path) {
				continue
			}
			ignored = append(ignored, path)
			continue
		}
		if strings.HasPrefix(line, "? ") {
			untracked = true
			continue
		}
		working = true
	}
	if len(ignored) != 0 {
		blockers = append(blockers, blocker("ignored_local_data", "Unknown ignored data would be removed: "+strings.Join(ignored, ", ")))
	}
	if untracked {
		blockers = append(blockers, blocker("untracked_changes", "Untracked data would be removed."))
	}
	if working {
		blockers = append(blockers, blocker("working_tree_changes", "Staged, unstaged, or submodule changes are present."))
	}
	return blockers
}

func disposableIgnoredPath(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	for _, segment := range strings.Split(clean, "/") {
		switch segment {
		case "node_modules", ".next", "dist", "dist-electron", "dist-prototype",
			"coverage", ".turbo", ".cache", "build", ".vite", ".astro", ".expo",
			".source", ".heroui-docs", "__pycache__":
			return true
		}
	}
	return strings.HasSuffix(clean, ".tsbuildinfo")
}

func blocker(code, message string) Blocker { return Blocker{Code: code, Message: message} }

func summarizeBlockers(blockers []Blocker) string {
	codes := make([]string, 0, len(blockers))
	for _, item := range blockers {
		codes = append(codes, item.Code)
	}
	return strings.Join(codes, ", ")
}
