package worktreeownership

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const (
	firstThread  = "019f4ed8-c60b-7de2-b40a-0e9ed9a5be2e"
	secondThread = "019f4ee7-3d3b-7473-9a19-23aaa8a9c886"
)

func TestPrepareCreatesStandardOwnedWorktreeAndCheckAcceptsOwner(t *testing.T) {
	mainPath := setupRepository(t)

	result, err := Prepare(PrepareOptions{
		IssueNumber: 123,
		IssueTitle:  "Add Codex-owned worktree workflow",
		StartPath:   mainPath,
		ThreadID:    firstThread,
	})
	if err != nil {
		t.Fatal(err)
	}
	expectedBranch := "issue-123-add-codex-owned-worktree-workflow"
	canonicalMainPath, err := filepath.EvalSymlinks(mainPath)
	if err != nil {
		t.Fatal(err)
	}
	expectedPath := filepath.Join(filepath.Dir(canonicalMainPath), ".worktrees", filepath.Base(canonicalMainPath), expectedBranch)
	if result.Status != "created" || result.Branch != expectedBranch || result.Path != expectedPath {
		t.Fatalf("unexpected result: %#v", result)
	}
	if owner := commandOutput(t, result.Path, "git", "config", "--worktree", "--get", ownerConfigKey); owner != firstThread {
		t.Fatalf("unexpected owner: %q", owner)
	}
	mainOwner := exec.Command("git", "-C", mainPath, "config", "--worktree", "--get", ownerConfigKey)
	if output, err := mainOwner.CombinedOutput(); err == nil || strings.TrimSpace(string(output)) != "" {
		t.Fatalf("main worktree unexpectedly inherited owner: %q, %v", output, err)
	}
	if _, err := os.Stat(filepath.Join(result.Path, "README.md")); err != nil {
		t.Fatalf("worktree was not checked out: %v", err)
	}

	checked, err := Check(CheckOptions{StartPath: result.Path, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if checked.Status != "ready" || checked.Owner != firstThread || checked.Issue != 123 {
		t.Fatalf("unexpected check result: %#v", checked)
	}
}

func TestPrepareReusesOneWorktreeForSameThread(t *testing.T) {
	mainPath := setupRepository(t)
	created, err := Prepare(PrepareOptions{
		StartPath: mainPath,
		TaskName:  "first task",
		ThreadID:  firstThread,
	})
	if err != nil {
		t.Fatal(err)
	}

	reused, err := Prepare(PrepareOptions{
		StartPath: mainPath,
		TaskName:  "another task in the same chat",
		ThreadID:  firstThread,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reused.Status != "ready" || reused.Path != created.Path || reused.Branch != created.Branch {
		t.Fatalf("same thread did not reuse its worktree: created=%#v reused=%#v", created, reused)
	}
}

func TestClaimOwnsExistingStandardWorktreeAndThenConfirmsIt(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-existing-worktree")

	claimed, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != "claimed" || claimed.Path != worktreePath || claimed.Owner != firstThread {
		t.Fatalf("unexpected claim result: %#v", claimed)
	}
	if status := commandOutput(t, worktreePath, "git", "status", "--porcelain"); status != "" {
		t.Fatalf("claim dirtied worktree: %q", status)
	}

	confirmed, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if confirmed.Status != "ready" || confirmed.Path != worktreePath {
		t.Fatalf("unexpected confirmation: %#v", confirmed)
	}
	if _, err := Check(CheckOptions{StartPath: worktreePath, ThreadID: firstThread}); err != nil {
		t.Fatalf("claimed worktree did not pass check: %v", err)
	}
}

func TestClaimSupportsDetachedAdministrativeCheckoutCreatedByMaterializer(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-materialized-worktree")
	command(t, mainPath, "git", "checkout", "--detach")

	claimed, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != "claimed" || claimed.Path != worktreePath || claimed.Owner != firstThread {
		t.Fatalf("unexpected claim result: %#v", claimed)
	}
}

func TestClaimUsesAdministrativeCheckoutWhenMainBranchIsLinkedElsewhere(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-materialized-worktree")
	command(t, mainPath, "git", "checkout", "--detach")
	linkedMainPath := filepath.Join(t.TempDir(), "linked-main")
	command(t, mainPath, "git", "worktree", "add", linkedMainPath, "main")

	claimed, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != "claimed" || claimed.Path != worktreePath || claimed.Owner != firstThread {
		t.Fatalf("unexpected claim result: %#v", claimed)
	}
}

func TestClaimSupportsCleanApprovedRemoteBranchBehindCurrentMain(t *testing.T) {
	mainPath := setupRepository(t)
	branch := "issue-326-read-only-smoke"
	command(t, mainPath, "git", "branch", branch, "origin/main")
	command(t, mainPath, "git", "push", "-u", "origin", branch)

	if err := os.WriteFile(filepath.Join(mainPath, "main.txt"), []byte("new main work\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	command(t, mainPath, "git", "add", "main.txt")
	command(t, mainPath, "git", "commit", "-m", "Advance main")
	command(t, mainPath, "git", "push", "origin", "main")

	worktreePath := addRemoteBranchWorktree(t, mainPath, branch)
	if head := commandOutput(t, worktreePath, "git", "rev-parse", "HEAD"); head == commandOutput(t, mainPath, "git", "rev-parse", "origin/main") {
		t.Fatal("fixture branch unexpectedly matches current main")
	}

	claimed, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != "claimed" || claimed.Branch != branch || claimed.Owner != firstThread {
		t.Fatalf("unexpected claim result: %#v", claimed)
	}
}

func TestClaimedWorktreeMayContinueWithChangesAndCommits(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-owned-active-work")
	if _, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktreePath, "active.txt"), []byte("in progress\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	dirty, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if dirty.Status != "ready" {
		t.Fatalf("owned dirty worktree was not reusable: %#v", dirty)
	}
	if _, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: secondThread}); err == nil || !strings.Contains(err.Error(), "belongs to Codex thread") {
		t.Fatalf("foreign thread was not rejected: %v", err)
	}

	command(t, worktreePath, "git", "add", "active.txt")
	command(t, worktreePath, "git", "commit", "-m", "Continue owned work")
	committed, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if committed.Status != "ready" {
		t.Fatalf("owned committed worktree was not reusable: %#v", committed)
	}
}

func TestConcurrentClaimsHaveExactlyOneOwner(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-concurrent-claim")
	type outcome struct {
		result Result
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wait sync.WaitGroup
	for _, threadID := range []string{firstThread, secondThread} {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: threadID})
			outcomes <- outcome{result: result, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(outcomes)

	winners := 0
	conflicts := 0
	winner := ""
	for outcome := range outcomes {
		if outcome.err == nil {
			winners++
			winner = outcome.result.Owner
			continue
		}
		if strings.Contains(outcome.err.Error(), "belongs to Codex thread") {
			conflicts++
			continue
		}
		t.Fatalf("unexpected claim error: %v", outcome.err)
	}
	if winners != 1 || conflicts != 1 {
		t.Fatalf("winners=%d conflicts=%d, want one each", winners, conflicts)
	}
	if _, err := Check(CheckOptions{StartPath: worktreePath, ThreadID: winner}); err != nil {
		t.Fatalf("winning owner did not pass check: %v", err)
	}
}

func TestClaimRejectsDirtyUnownedWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-dirty-unowned")
	if err := os.WriteFile(filepath.Join(worktreePath, "unowned.txt"), []byte("unknown\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err == nil || !strings.Contains(err.Error(), "contains changes") {
		t.Fatalf("expected dirty-worktree rejection, got %v", err)
	}
	if owner := readWorktreeConfig(worktreePath, ownerConfigKey); owner != "" {
		t.Fatalf("dirty worktree was unexpectedly claimed by %q", owner)
	}
}

func TestClaimRejectsCleanUnownedWorktreeWithExistingCommit(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-committed-unowned")
	if err := os.WriteFile(filepath.Join(worktreePath, "committed.txt"), []byte("unknown\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	command(t, worktreePath, "git", "add", "committed.txt")
	command(t, worktreePath, "git", "commit", "-m", "Unknown existing work")
	if status := commandOutput(t, worktreePath, "git", "status", "--porcelain"); status != "" {
		t.Fatalf("fixture is not clean: %q", status)
	}

	_, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err == nil || !strings.Contains(err.Error(), "HEAD does not match origin/main") {
		t.Fatalf("expected committed-work rejection, got %v", err)
	}
	if owner := readWorktreeConfig(worktreePath, ownerConfigKey); owner != "" {
		t.Fatalf("committed worktree was unexpectedly claimed by %q", owner)
	}
}

func TestCleanupRemovesOnlyUnchangedCreatedWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	branch := "task-cleanup-created"
	worktreePath := addStandardWorktree(t, mainPath, branch)
	repo, _, err := inspectRepository(mainPath)
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("configuration failed")

	err = cleanupCreatedWorktree(repo, worktreePath, branch, firstThread, cause)
	if !errors.Is(err, cause) {
		t.Fatalf("cleanup did not preserve the original error: %v", err)
	}
	if pathExists(worktreePath) || branchExists(mainPath, branch) {
		t.Fatalf("clean candidate was not fully removed: path=%v branch=%v", pathExists(worktreePath), branchExists(mainPath, branch))
	}
}

func TestCleanupPreservesChangedCreatedWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	branch := "task-preserve-created"
	worktreePath := addStandardWorktree(t, mainPath, branch)
	repo, _, err := inspectRepository(mainPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktreePath, "keep.txt"), []byte("keep\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	err = cleanupCreatedWorktree(repo, worktreePath, branch, firstThread, errors.New("configuration failed"))
	if err == nil || !strings.Contains(err.Error(), "preserving newly created worktree") {
		t.Fatalf("changed candidate was not preserved safely: %v", err)
	}
	if !pathExists(worktreePath) || !branchExists(mainPath, branch) {
		t.Fatalf("changed candidate was removed: path=%v branch=%v", pathExists(worktreePath), branchExists(mainPath, branch))
	}
}

func TestDifferentThreadGetsDifferentWorktreeAndCannotUseFirst(t *testing.T) {
	mainPath := setupRepository(t)
	first, err := Prepare(PrepareOptions{
		StartPath: mainPath,
		TaskName:  "shared task name",
		ThreadID:  firstThread,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Prepare(PrepareOptions{
		StartPath: mainPath,
		TaskName:  "shared task name",
		ThreadID:  secondThread,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Path == first.Path || second.Branch == first.Branch {
		t.Fatalf("different threads shared a worktree: first=%#v second=%#v", first, second)
	}
	if !strings.HasPrefix(second.Branch, "task-shared-task-name-") {
		t.Fatalf("collision suffix missing from %q", second.Branch)
	}

	_, err = Check(CheckOptions{StartPath: first.Path, ThreadID: secondThread})
	if err == nil || !strings.Contains(err.Error(), "belongs to Codex thread") {
		t.Fatalf("expected ownership rejection, got %v", err)
	}
}

func TestCheckRejectsMainAndUnmanagedWorktrees(t *testing.T) {
	mainPath := setupRepository(t)
	if _, err := Check(CheckOptions{StartPath: mainPath, ThreadID: firstThread}); err == nil || !strings.Contains(err.Error(), "main worktree") {
		t.Fatalf("expected main rejection, got %v", err)
	}
	if _, err := Claim(ClaimOptions{StartPath: mainPath, ThreadID: firstThread}); err == nil || !strings.Contains(err.Error(), "main worktree") {
		t.Fatalf("expected main claim rejection, got %v", err)
	}

	outsidePath := filepath.Join(t.TempDir(), "outside")
	command(t, mainPath, "git", "worktree", "add", "-b", "manual-branch", outsidePath, "origin/main")
	if _, err := Check(CheckOptions{StartPath: outsidePath, ThreadID: firstThread}); err == nil || !strings.Contains(err.Error(), "standard path") {
		t.Fatalf("expected path rejection, got %v", err)
	}
	if _, err := Claim(ClaimOptions{StartPath: outsidePath, ThreadID: firstThread}); err == nil || !strings.Contains(err.Error(), "standard path") {
		t.Fatalf("expected outside-path claim rejection, got %v", err)
	}
}

func TestMissingThreadIDFailsClosed(t *testing.T) {
	mainPath := setupRepository(t)
	if _, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "task"}); err == nil || !strings.Contains(err.Error(), "CODEX_THREAD_ID") {
		t.Fatalf("expected missing thread rejection, got %v", err)
	}
	if _, err := Check(CheckOptions{StartPath: mainPath}); err == nil || !strings.Contains(err.Error(), "CODEX_THREAD_ID") {
		t.Fatalf("expected missing thread rejection, got %v", err)
	}
	if _, err := Claim(ClaimOptions{StartPath: mainPath}); err == nil || !strings.Contains(err.Error(), "CODEX_THREAD_ID") {
		t.Fatalf("expected missing thread rejection, got %v", err)
	}
	if _, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "task", ThreadID: "not-a-thread"}); err == nil || !strings.Contains(err.Error(), "valid Codex thread") {
		t.Fatalf("expected invalid thread rejection, got %v", err)
	}
}

func addStandardWorktree(t *testing.T, mainPath string, branch string) string {
	t.Helper()
	canonicalMainPath, err := filepath.EvalSymlinks(mainPath)
	if err != nil {
		t.Fatal(err)
	}
	worktreePath := filepath.Join(
		filepath.Dir(canonicalMainPath),
		".worktrees",
		filepath.Base(canonicalMainPath),
		branch,
	)
	command(t, mainPath, "git", "worktree", "add", "-b", branch, worktreePath, "origin/main")
	return worktreePath
}

func addRemoteBranchWorktree(t *testing.T, mainPath string, branch string) string {
	t.Helper()
	canonicalMainPath, err := filepath.EvalSymlinks(mainPath)
	if err != nil {
		t.Fatal(err)
	}
	worktreePath := filepath.Join(
		filepath.Dir(canonicalMainPath),
		".worktrees",
		filepath.Base(canonicalMainPath),
		branch,
	)
	command(t, mainPath, "git", "worktree", "add", worktreePath, branch)
	return worktreePath
}

func TestSlugUsesStableBranchSafeNames(t *testing.T) {
	if actual := Slug("  Add Worktrees & Session Ownership!  "); actual != "add-worktrees-session-ownership" {
		t.Fatalf("unexpected slug: %q", actual)
	}
	if actual := Slug("---"); actual != "work" {
		t.Fatalf("unexpected empty fallback: %q", actual)
	}
}

func setupRepository(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	mainPath := filepath.Join(root, "project-space")
	command(t, root, "git", "init", "--bare", "--initial-branch=main", remote)
	command(t, root, "git", "clone", remote, mainPath)
	command(t, mainPath, "git", "config", "user.email", "codex@example.com")
	command(t, mainPath, "git", "config", "user.name", "Codex Test")
	if err := os.WriteFile(filepath.Join(mainPath, "README.md"), []byte("test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	command(t, mainPath, "git", "add", "README.md")
	command(t, mainPath, "git", "commit", "-m", "Initial commit")
	command(t, mainPath, "git", "push", "-u", "origin", "main")
	command(t, mainPath, "git", "remote", "set-head", "origin", "main")
	return mainPath
}

func command(t *testing.T, directory string, name string, args ...string) {
	t.Helper()
	commandOutput(t, directory, name, args...)
}

func commandOutput(t *testing.T, directory string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = directory
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}
