package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const commandTestThreadID = "019f49e1-cc3d-7243-bc12-75c74c786457"

func TestWorktreePrepareClaimsThenConfirmsCurrentTask(t *testing.T) {
	worktree := createCommandTestWorktree(t)
	t.Chdir(worktree)
	t.Setenv("CODEX_THREAD_ID", commandTestThreadID)

	first := newWorktreeCommand()
	firstOutput := &bytes.Buffer{}
	first.SetOut(firstOutput)
	first.SetArgs([]string{"prepare"})
	if err := first.Execute(); err != nil {
		t.Fatalf("first prepare: %v", err)
	}
	if !strings.Contains(firstOutput.String(), "Worktree claimed") || !strings.Contains(firstOutput.String(), commandTestThreadID) {
		t.Fatalf("unexpected first output: %q", firstOutput.String())
	}

	second := newWorktreeCommand()
	secondOutput := &bytes.Buffer{}
	second.SetOut(secondOutput)
	second.SetArgs([]string{"prepare"})
	if err := second.Execute(); err != nil {
		t.Fatalf("second prepare: %v", err)
	}
	if !strings.Contains(secondOutput.String(), "Worktree ownership confirmed") {
		t.Fatalf("unexpected second output: %q", secondOutput.String())
	}
}

func TestWorktreePrepareRejectsSideChat(t *testing.T) {
	worktree := createCommandTestWorktree(t)
	t.Chdir(worktree)
	t.Setenv("CODEX_THREAD_ID", "")

	command := newWorktreeCommand()
	command.SetArgs([]string{"prepare"})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "no persistent Codex thread") {
		t.Fatalf("error = %v, want persistent-thread guidance", err)
	}
}

func createCommandTestWorktree(t *testing.T) string {
	t.Helper()
	repository := t.TempDir()
	runCommandGit(t, repository, "init", "--initial-branch=main")
	runCommandGit(t, repository, "config", "user.email", "codex@example.test")
	runCommandGit(t, repository, "config", "user.name", "Codex Test")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("test\n"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	runCommandGit(t, repository, "add", "README.md")
	runCommandGit(t, repository, "commit", "-m", "Initial commit")
	worktree := filepath.Join(t.TempDir(), "feature-command")
	runCommandGit(t, repository, "worktree", "add", "-b", "feature-command", worktree)
	return worktree
}

func runCommandGit(t *testing.T, directory string, args ...string) {
	t.Helper()
	commandArgs := append([]string{"-C", directory}, args...)
	output, err := exec.Command("git", commandArgs...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
}
