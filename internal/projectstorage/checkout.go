package projectstorage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

var safeNamePattern = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

type CheckoutCandidate struct {
	Bytes      int64  `json:"bytes"`
	DefaultRef string `json:"defaultRef,omitempty"`
	HeadSHA    string `json:"headSha"`
	Path       string `json:"path"`
	ProjectID  string `json:"projectId"`
	RemoteURL  string `json:"remoteUrl"`
	Repository string `json:"repository"`
}

type CheckoutPlan struct {
	Blockers      []Blocker          `json:"blockers"`
	Candidate     *CheckoutCandidate `json:"candidate,omitempty"`
	CheckedAt     string             `json:"checkedAt"`
	Purgeable     bool               `json:"purgeable"`
	SchemaVersion int                `json:"schemaVersion"`
}

type CheckoutRecoveryManifest struct {
	CheckedAt     string `json:"checkedAt"`
	DefaultRef    string `json:"defaultRef"`
	HeadSHA       string `json:"headSha"`
	MeasuredBytes int64  `json:"measuredBytes"`
	OriginalPath  string `json:"originalPath"`
	ProjectID     string `json:"projectId"`
	RemoteURL     string `json:"remoteUrl"`
	Repository    string `json:"repository"`
	SchemaVersion int    `json:"schemaVersion"`
}

type CheckoutPurgeResult struct {
	FreeSpaceDeltaBytes  int64  `json:"freeSpaceDeltaBytes,omitempty"`
	FreeSpaceError       string `json:"freeSpaceError,omitempty"`
	FreeSpaceMeasured    bool   `json:"freeSpaceMeasured"`
	HeadSHA              string `json:"headSha"`
	ManifestPath         string `json:"manifestPath"`
	MeasuredBytesRemoved int64  `json:"measuredBytesRemoved"`
	Path                 string `json:"path"`
	SchemaVersion        int    `json:"schemaVersion"`
	State                string `json:"state"`
	Verified             bool   `json:"verified"`
}

type CheckoutEvidenceCheck func(context.Context, CheckoutCandidate) ([]Blocker, error)

type CheckoutOptions struct {
	AuthorizedRoot string
	Checks         []CheckoutEvidenceCheck
	LockDirectory  string
	Meter          Meter
	Now            func() time.Time
	RecoveryDir    string
}

func PlanCheckoutPurge(
	ctx context.Context,
	projectID, repository, projectPath string,
	options CheckoutOptions,
) (CheckoutPlan, error) {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	report, err := Audit(ctx, projectID, repository, projectPath, Options{Meter: zeroMeter, Now: now})
	if err != nil {
		return CheckoutPlan{}, err
	}
	plan := CheckoutPlan{
		Blockers:  make([]Blocker, 0),
		CheckedAt: now().UTC().Format(time.RFC3339Nano), SchemaVersion: 1,
	}
	main := mainEntry(report.Worktrees)
	if main == nil {
		return CheckoutPlan{}, errors.New("registered main checkout was not found")
	}
	candidate := CheckoutCandidate{
		HeadSHA: main.HeadSHA, Path: report.Path,
		ProjectID: projectID, RemoteURL: "https://github.com/" + repository + ".git",
		Repository: repository,
	}
	plan.Candidate = &candidate
	if len(report.Worktrees) != 1 {
		plan.Blockers = append(plan.Blockers, blocker("linked_worktrees", "All linked worktrees must be purged first."))
	} else {
		candidate.Bytes, err = measureOne(ctx, report.Path, options.Meter)
		if err != nil {
			plan.Blockers = append(plan.Blockers, blocker("storage_unavailable", "The checkout storage measurement is incomplete."))
		}
		plan.Candidate = &candidate
	}
	if !headPattern.MatchString(main.HeadSHA) || strings.TrimSpace(main.Branch) == "" {
		plan.Blockers = append(plan.Blockers, blocker("git_identity", "Git did not provide a stable branch and head commit."))
	}
	plan.Blockers = append(plan.Blockers, checkoutPathBlockers(report.Path, options.AuthorizedRoot)...)
	plan.Blockers = append(plan.Blockers, checkoutLocalBlockers(ctx, report.Path)...)
	if len(plan.Blockers) == 0 {
		for _, check := range options.Checks {
			if check == nil {
				continue
			}
			additional, checkErr := check(ctx, candidate)
			if checkErr != nil {
				plan.Blockers = append(plan.Blockers, blocker("evidence_unavailable", checkErr.Error()))
				continue
			}
			plan.Blockers = append(plan.Blockers, additional...)
		}
		defaultRef, defaultErr := git(ctx, report.Path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
		if defaultErr != nil || strings.TrimSpace(defaultRef) == "" {
			plan.Blockers = append(plan.Blockers, blocker("default_branch_unknown", "The verified origin default branch is unavailable."))
		} else {
			candidate.DefaultRef = strings.TrimSpace(defaultRef)
			plan.Candidate = &candidate
		}
	}
	plan.Purgeable = len(plan.Blockers) == 0
	return plan, nil
}

func PurgeCheckout(
	ctx context.Context,
	projectID, repository, projectPath, expectedHead string,
	options CheckoutOptions,
) (CheckoutPurgeResult, error) {
	if len(options.Checks) < 3 {
		return CheckoutPurgeResult{}, errors.New("checkout purge safety checks are unavailable")
	}
	if !headPattern.MatchString(expectedHead) {
		return CheckoutPurgeResult{}, errors.New("--expect-head must be the exact full checkout commit")
	}
	if strings.TrimSpace(options.LockDirectory) == "" || strings.TrimSpace(options.RecoveryDir) == "" {
		return CheckoutPurgeResult{}, errors.New("checkout purge safety directories are unavailable")
	}
	if err := os.MkdirAll(options.LockDirectory, 0o700); err != nil {
		return CheckoutPurgeResult{}, fmt.Errorf("create checkout purge lock directory: %w", err)
	}
	lockPath := filepath.Join(options.LockDirectory, "checkout-purge.lock")
	fileLock := flock.New(lockPath, flock.SetPermissions(0o600))
	lockContext, cancel := context.WithTimeout(ctx, purgeLockTimeout)
	defer cancel()
	locked, err := fileLock.TryLockContext(lockContext, 25*time.Millisecond)
	if err != nil || !locked {
		return CheckoutPurgeResult{}, errors.New("another checkout purge operation is active")
	}
	defer fileLock.Unlock()

	plan, err := PlanCheckoutPurge(ctx, projectID, repository, projectPath, options)
	if err != nil {
		return CheckoutPurgeResult{}, err
	}
	if plan.Candidate == nil || plan.Candidate.HeadSHA != expectedHead {
		return CheckoutPurgeResult{}, errors.New("checkout head changed after review")
	}
	if !plan.Purgeable {
		return CheckoutPurgeResult{}, fmt.Errorf("checkout is blocked: %s", summarizeBlockers(plan.Blockers))
	}
	manifestPath, err := writeRecoveryManifest(options.RecoveryDir, CheckoutRecoveryManifest{
		CheckedAt: plan.CheckedAt, DefaultRef: plan.Candidate.DefaultRef,
		HeadSHA: expectedHead, MeasuredBytes: plan.Candidate.Bytes,
		OriginalPath: plan.Candidate.Path, ProjectID: projectID,
		RemoteURL: plan.Candidate.RemoteURL, Repository: repository, SchemaVersion: 1,
	})
	if err != nil {
		return CheckoutPurgeResult{}, err
	}
	freeBefore, freeBeforeErr := diskFreeBytes(plan.Candidate.Path)
	if err := os.RemoveAll(plan.Candidate.Path); err != nil {
		return CheckoutPurgeResult{}, fmt.Errorf("remove exact checkout path: %w", err)
	}
	if _, err := os.Lstat(plan.Candidate.Path); !os.IsNotExist(err) {
		return CheckoutPurgeResult{}, errors.New("checkout path still exists after removal")
	}
	result := CheckoutPurgeResult{
		HeadSHA: expectedHead, ManifestPath: manifestPath,
		MeasuredBytesRemoved: plan.Candidate.Bytes, Path: plan.Candidate.Path,
		SchemaVersion: 1, State: "purged", Verified: true,
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

func mainEntry(entries []Entry) *Entry {
	for index := range entries {
		if entries[index].IsMain {
			return &entries[index]
		}
	}
	return nil
}

func checkoutPathBlockers(path, authorizedRoot string) []Blocker {
	root, rootErr := filepath.EvalSymlinks(authorizedRoot)
	pathInfo, pathErr := os.Lstat(path)
	if rootErr != nil || pathErr != nil || pathInfo.Mode()&os.ModeSymlink != 0 {
		return []Blocker{blocker("path_scope", "The checkout path or authorized projects root could not be verified.")}
	}
	root, rootErr = filepath.Abs(root)
	path, pathErr = filepath.Abs(path)
	if rootErr != nil || pathErr != nil || !inside(root, path) || filepath.Base(path) == ".worktrees" || strings.Contains(filepath.ToSlash(path), "/.worktrees/") {
		return []Blocker{blocker("path_scope", "The checkout is outside the authorized main project root.")}
	}
	return nil
}

func checkoutLocalBlockers(ctx context.Context, path string) []Blocker {
	blockers := make([]Blocker, 0)
	status, err := git(ctx, path, "status", "--porcelain=v2", "--untracked-files=all", "--ignored=matching")
	if err != nil {
		blockers = append(blockers, blocker("git_status_unavailable", "Git working state could not be inspected."))
	} else {
		blockers = append(blockers, statusBlockers(status)...)
	}
	blockers = append(blockers, gitOperationBlockers(ctx, path)...)
	stashes, err := git(ctx, path, "stash", "list")
	if err != nil {
		blockers = append(blockers, blocker("stash_evidence_unavailable", "Git stashes could not be inspected."))
	} else if strings.TrimSpace(stashes) != "" {
		blockers = append(blockers, blocker("local_stashes", "Local Git stashes would be lost."))
	}
	remotes, err := git(ctx, path, "remote")
	if err != nil || strings.TrimSpace(remotes) != "origin" {
		blockers = append(blockers, blocker("remote_topology", "The checkout must have exactly one remote named origin."))
	}
	configuration, err := git(ctx, path, "config", "--local", "--name-only", "--list")
	if err != nil {
		blockers = append(blockers, blocker("repository_config_unavailable", "Local repository configuration could not be inspected."))
	} else if unsupported := unsupportedLocalConfig(configuration); len(unsupported) != 0 {
		blockers = append(blockers, blocker("local_repository_config", "Local repository settings would be lost: "+strings.Join(unsupported, ", ")))
	}
	hooksPath, err := git(ctx, path, "rev-parse", "--git-path", "hooks")
	if err != nil {
		blockers = append(blockers, blocker("hooks_evidence_unavailable", "Local Git hooks could not be inspected."))
	} else if customHooks(strings.TrimSpace(hooksPath)) {
		blockers = append(blockers, blocker("custom_git_hooks", "Custom local Git hooks would be lost."))
	}
	if _, err := os.Lstat(filepath.Join(path, ".gitmodules")); err == nil {
		blockers = append(blockers, blocker("submodules_present", "Repositories with submodules require a separate reconstructibility check."))
	}
	alternatesPath, err := git(ctx, path, "rev-parse", "--git-path", "objects/info/alternates")
	if err != nil {
		blockers = append(blockers, blocker("object_store_evidence_unavailable", "Git object storage could not be inspected."))
	} else if _, statErr := os.Lstat(strings.TrimSpace(alternatesPath)); statErr == nil {
		blockers = append(blockers, blocker("alternate_object_store", "The checkout depends on an external Git object store."))
	}
	return blockers
}

func unsupportedLocalConfig(output string) []string {
	allowedExact := map[string]bool{
		"core.bare": true, "core.filemode": true, "core.ignorecase": true,
		"core.logallrefupdates": true, "core.precomposeunicode": true,
		"core.repositoryformatversion": true, "extensions.worktreeconfig": true,
		"lfs.repositoryformatversion": true, "remote.origin.fetch": true,
		"remote.origin.url": true,
	}
	unsupported := make([]string, 0)
	for _, key := range strings.Fields(strings.ToLower(output)) {
		if allowedExact[key] || strings.HasPrefix(key, "branch.") &&
			(strings.HasSuffix(key, ".merge") || strings.HasSuffix(key, ".remote")) {
			continue
		}
		unsupported = append(unsupported, key)
	}
	return unsupported
}

func gitOperationBlockers(ctx context.Context, path string) []Blocker {
	blockers := make([]Blocker, 0)
	for operation, marker := range map[string]string{
		"merge": "MERGE_HEAD", "rebase": "rebase-merge", "rebase-apply": "rebase-apply",
		"cherry-pick": "CHERRY_PICK_HEAD", "bisect": "BISECT_LOG",
	} {
		markerPath, err := git(ctx, path, "rev-parse", "--git-path", marker)
		if err == nil {
			if _, statErr := os.Lstat(strings.TrimSpace(markerPath)); statErr == nil {
				blockers = append(blockers, blocker("git_operation", "A Git "+operation+" operation is still in progress."))
			}
		}
	}
	return blockers
}

func customHooks(directory string) bool {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return !os.IsNotExist(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() && !strings.HasSuffix(entry.Name(), ".sample") {
			return true
		}
	}
	return false
}

func writeRecoveryManifest(directory string, manifest CheckoutRecoveryManifest) (string, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("create recovery directory: %w", err)
	}
	name := safeNamePattern.ReplaceAllString(manifest.Repository, "-") + "-" + manifest.HeadSHA[:12] + ".json"
	path := filepath.Join(directory, name)
	temporary, err := os.CreateTemp(directory, ".recovery-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create recovery manifest: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("secure recovery manifest: %w", err)
	}
	encoder := json.NewEncoder(temporary)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(manifest); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("write recovery manifest: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("sync recovery manifest: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("close recovery manifest: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return "", fmt.Errorf("publish recovery manifest: %w", err)
	}
	return path, nil
}
