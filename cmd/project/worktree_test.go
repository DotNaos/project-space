package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/worktreecheckout"
	"github.com/DotNaos/project-space/internal/worktreeownership"
)

const worktreeCommandThread = "019f49e1-cc3d-7243-bc12-75c74c786457"

func TestWorktreeCommandExposesOwnershipCommands(t *testing.T) {
	command := newWorktreeCommand()
	if _, _, err := command.Find([]string{"prepare"}); err != nil {
		t.Fatalf("prepare command missing: %v", err)
	}
	if _, _, err := command.Find([]string{"check"}); err != nil {
		t.Fatalf("check command missing: %v", err)
	}
	if _, _, err := command.Find([]string{"materialize"}); err != nil {
		t.Fatalf("materialize command missing: %v", err)
	}
	if _, _, err := command.Find([]string{"recover"}); err != nil {
		t.Fatalf("recover command missing: %v", err)
	}
}

func TestWorktreeMaterializeUsesOnlyValidatedIdentityFlags(t *testing.T) {
	t.Setenv("HOME", "/home/tester")
	var received worktreecheckout.Request
	command := newWorktreeMaterializeCommandWith(func(_ context.Context, request worktreecheckout.Request) (worktreecheckout.Result, error) {
		received = request
		return worktreecheckout.Result{Branch: request.Branch, Commit: request.Commit, Path: "/home/tester/projects/.worktrees/project-space/feature/remote", Repository: request.Repository, Status: "created"}, nil
	})
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"--repository", "DotNaos/project-space", "--branch", "feature/remote", "--commit", strings.Repeat("a", 40), "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if received.Repository != "DotNaos/project-space" || received.Branch != "feature/remote" || received.WorktreesRoot != "/home/tester/projects/.worktrees" {
		t.Fatalf("unexpected request: %#v", received)
	}
	if !strings.Contains(output.String(), `"status":"created"`) {
		t.Fatalf("unexpected output: %s", output.String())
	}
}

func TestReadGitHubIssueRequiresOpenIssue(t *testing.T) {
	oldRunner := runExternalCommand
	t.Cleanup(func() { runExternalCommand = oldRunner })
	runExternalCommand = func(_ string, _ []byte, name string, args ...string) (string, error) {
		if name != "gh" || strings.Join(args, " ") != "issue view 123 --json number,state,title,url" {
			return "", errors.New("unexpected command")
		}
		return `{"number":123,"state":"OPEN","title":"Owned worktrees","url":"https://github.com/example/repo/issues/123"}`, nil
	}

	issue, err := readGitHubIssue(".", 123)
	if err != nil {
		t.Fatal(err)
	}
	if issue.Number != 123 || issue.Title != "Owned worktrees" {
		t.Fatalf("unexpected issue: %#v", issue)
	}

	runExternalCommand = func(_ string, _ []byte, _ string, _ ...string) (string, error) {
		return `{"number":123,"state":"CLOSED","title":"Owned worktrees","url":"https://github.com/example/repo/issues/123"}`, nil
	}
	if _, err := readGitHubIssue(".", 123); err == nil || !strings.Contains(err.Error(), "not open") {
		t.Fatalf("expected closed issue rejection, got %v", err)
	}
}

func TestPrintWorktreeResultAsJSON(t *testing.T) {
	command := newWorktreeCommand()
	output := &bytes.Buffer{}
	command.SetOut(output)
	err := printWorktreeResult(command, worktreeownership.Result{
		BaseRef:   "origin/main",
		Branch:    "task-owned-worktrees",
		Owner:     "thread-123",
		Path:      "/projects/.worktrees/repo/task-owned-worktrees",
		Project:   "repo",
		Status:    "created",
		Task:      "owned worktrees",
		Worktrees: "/projects/.worktrees/repo",
	}, "", "json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"ownerThreadId": "thread-123"`) ||
		!strings.Contains(output.String(), `"status": "created"`) {
		t.Fatalf("unexpected JSON: %s", output.String())
	}
}

func TestPrepareWithoutTaskClaimsCurrentStandardWorktree(t *testing.T) {
	worktreePath := setupWorktreeCommandRepository(t)
	t.Chdir(worktreePath)
	t.Setenv("CODEX_THREAD_ID", worktreeCommandThread)

	command := newWorktreeCommand()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"prepare", "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"status": "claimed"`) ||
		!strings.Contains(output.String(), `"ownerThreadId": "`+worktreeCommandThread+`"`) {
		t.Fatalf("unexpected claim output: %s", output.String())
	}
}

func setupWorktreeCommandRepository(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	mainPath := filepath.Join(root, "project-space")
	runWorktreeCommandGit(t, root, "init", "--bare", "--initial-branch=main", remote)
	runWorktreeCommandGit(t, root, "clone", remote, mainPath)
	runWorktreeCommandGit(t, mainPath, "config", "user.email", "codex@example.test")
	runWorktreeCommandGit(t, mainPath, "config", "user.name", "Codex Test")
	if err := os.WriteFile(filepath.Join(mainPath, "README.md"), []byte("test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runWorktreeCommandGit(t, mainPath, "add", "README.md")
	runWorktreeCommandGit(t, mainPath, "commit", "-m", "Initial commit")
	runWorktreeCommandGit(t, mainPath, "push", "-u", "origin", "main")
	runWorktreeCommandGit(t, mainPath, "remote", "set-head", "origin", "main")
	worktreePath := filepath.Join(root, ".worktrees", "project-space", "task-command-claim")
	runWorktreeCommandGit(t, mainPath, "worktree", "add", "-b", "task-command-claim", worktreePath, "origin/main")
	return worktreePath
}

func runWorktreeCommandGit(t *testing.T, directory string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = directory
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
}
