package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/worktreeownership"
)

func TestWorktreeCommandExposesPrepareAndCheck(t *testing.T) {
	command := newWorktreeCommand()
	if _, _, err := command.Find([]string{"prepare"}); err != nil {
		t.Fatalf("prepare command missing: %v", err)
	}
	if _, _, err := command.Find([]string{"check"}); err != nil {
		t.Fatalf("check command missing: %v", err)
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
