package worktreeownership

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

	outsidePath := filepath.Join(t.TempDir(), "outside")
	command(t, mainPath, "git", "worktree", "add", "-b", "manual-branch", outsidePath, "origin/main")
	if _, err := Check(CheckOptions{StartPath: outsidePath, ThreadID: firstThread}); err == nil || !strings.Contains(err.Error(), "standard path") {
		t.Fatalf("expected path rejection, got %v", err)
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
	if _, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "task", ThreadID: "not-a-thread"}); err == nil || !strings.Contains(err.Error(), "valid Codex thread") {
		t.Fatalf("expected invalid thread rejection, got %v", err)
	}
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
