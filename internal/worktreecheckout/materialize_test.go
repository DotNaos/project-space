package worktreecheckout

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRequestPreservesSafeBranchHierarchy(t *testing.T) {
	request := Request{Repository: "DotNaos/project-space", Branch: "feature/remote-dev", Commit: strings.Repeat("a", 40), WorktreesRoot: "/home/oli/projects/.worktrees"}
	if _, _, err := validateRequest(request); err != nil {
		t.Fatal(err)
	}
	for _, branch := range []string{"../escape", "feature/../../escape", "/absolute", `windows\escape`, "feature//empty", "feature/.git/value"} {
		request.Branch = branch
		if _, _, err := validateRequest(request); err == nil {
			t.Fatalf("expected unsafe branch %q to fail", branch)
		}
	}
}

func TestMaterializeCreatesExactManagedBranchPathAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	seed := filepath.Join(root, "seed")
	runGit(t, root, "init", "--bare", "--initial-branch=main", remote)
	runGit(t, root, "clone", remote, seed)
	runGit(t, seed, "config", "user.email", "test@example.test")
	runGit(t, seed, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "add", "README.md")
	runGit(t, seed, "commit", "-m", "initial")
	runGit(t, seed, "branch", "feature/remote-dev")
	runGit(t, seed, "push", "origin", "main", "feature/remote-dev")
	commit := runGit(t, seed, "rev-parse", "feature/remote-dev")

	worktreesRoot := filepath.Join(root, "projects", ".worktrees")
	runner := rewriteRemoteRunner{remote: remote, delegate: execRunner{}}
	request := Request{Repository: "DotNaos/project-space", Branch: "feature/remote-dev", Commit: commit, WorktreesRoot: worktreesRoot}
	result, err := materialize(ctx, request, runner)
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(worktreesRoot, "project-space", "feature", "remote-dev")
	if result.Path != expected || result.Status != "created" {
		t.Fatalf("unexpected result: %#v", result)
	}
	ready, err := materialize(ctx, request, runner)
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(ready.Path, expected) || ready.Status != "ready" {
		t.Fatalf("unexpected idempotent result: %#v", ready)
	}
}

func TestMaterializePlacesDefaultBranchUnderManagedWorktrees(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	seed := filepath.Join(root, "seed")
	runGit(t, root, "init", "--bare", "--initial-branch=main", remote)
	runGit(t, root, "clone", remote, seed)
	runGit(t, seed, "config", "user.email", "test@example.test")
	runGit(t, seed, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "add", "README.md")
	runGit(t, seed, "commit", "-m", "initial")
	runGit(t, seed, "push", "origin", "main")
	commit := runGit(t, seed, "rev-parse", "HEAD")
	worktreesRoot := filepath.Join(root, "projects", ".worktrees")
	result, err := materialize(ctx, Request{Repository: "DotNaos/project-space", Branch: "main", Commit: commit, WorktreesRoot: worktreesRoot}, rewriteRemoteRunner{remote: remote, delegate: execRunner{}})
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(result.Path, filepath.Join(worktreesRoot, "project-space", "main")) {
		t.Fatalf("default branch escaped managed root: %#v", result)
	}
}

func TestMaterializeRejectsSymlinkedBranchParentBeforeGit(t *testing.T) {
	root := t.TempDir()
	worktreesRoot := filepath.Join(root, "projects", ".worktrees")
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(filepath.Join(worktreesRoot, "project-space"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(worktreesRoot, "project-space", "feature")); err != nil {
		t.Fatal(err)
	}
	request := Request{Repository: "DotNaos/project-space", Branch: "feature/remote-dev", Commit: strings.Repeat("a", 40), WorktreesRoot: worktreesRoot}
	if _, err := materialize(context.Background(), request, panicRunner{}); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink rejection, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "remote-dev")); !os.IsNotExist(err) {
		t.Fatalf("unexpected outside mutation: %v", err)
	}
}

func TestMaterializeRejectsStaleFreeLocalBranchBeforeWorktreeAdd(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	seed := filepath.Join(root, "seed")
	runGit(t, root, "init", "--bare", "--initial-branch=main", remote)
	runGit(t, root, "clone", remote, seed)
	runGit(t, seed, "config", "user.email", "test@example.test")
	runGit(t, seed, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "add", "README.md")
	runGit(t, seed, "commit", "-m", "one")
	old := runGit(t, seed, "rev-parse", "HEAD")
	runGit(t, seed, "push", "origin", "main")
	runGit(t, seed, "checkout", "-b", "feature/remote-dev")
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "commit", "-am", "two")
	approved := runGit(t, seed, "rev-parse", "HEAD")
	runGit(t, seed, "push", "origin", "feature/remote-dev")
	projects := filepath.Join(root, "projects")
	base := filepath.Join(projects, "project-space")
	runGit(t, root, "clone", remote, base)
	runGit(t, base, "branch", "feature/remote-dev", old)
	worktreesRoot := filepath.Join(projects, ".worktrees")
	runner := rewriteRemoteRunner{remote: remote, delegate: execRunner{}}
	request := Request{Repository: "DotNaos/project-space", Branch: "feature/remote-dev", Commit: approved, WorktreesRoot: worktreesRoot}
	if _, err := materialize(ctx, request, runner); err == nil || !strings.Contains(err.Error(), "local branch") {
		t.Fatalf("expected stale local branch rejection, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(worktreesRoot, "project-space", "feature", "remote-dev")); !os.IsNotExist(err) {
		t.Fatalf("worktree was mutated before rejection: %v", err)
	}
}

type panicRunner struct{}

func (panicRunner) Run(_ context.Context, _ string, args ...string) (string, error) {
	if strings.Join(args, " ") == "check-ref-format --branch feature/remote-dev" {
		return "feature/remote-dev", nil
	}
	panic("mutating git must not run")
}

type rewriteRemoteRunner struct {
	remote   string
	delegate commandRunner
}

func (runner rewriteRemoteRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	next := append([]string{}, args...)
	for index, value := range next {
		if value == "https://github.com/DotNaos/project-space.git" {
			next[index] = runner.remote
		}
	}
	result, err := runner.delegate.Run(ctx, name, next...)
	if name == "git" && len(next) >= 5 && next[0] == "-C" && next[2] == "remote" && next[3] == "get-url" && err == nil {
		return "https://github.com/DotNaos/project-space.git", nil
	}
	return result, err
}

func runGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}
