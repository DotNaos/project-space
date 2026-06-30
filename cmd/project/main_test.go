package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCreateGitHubVisibilityRequiresGitHub(t *testing.T) {
	cmd := newRootCommand()
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetArgs([]string{"create", "my-app", "--github-visibility", "public"})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "--github-visibility requires --github") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCreateRejectsInvalidGitHubVisibility(t *testing.T) {
	cmd := newRootCommand()
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetArgs([]string{"create", "my-app", "--github", "--github-visibility", "internal"})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "--github-visibility must be private or public") {
		t.Fatalf("unexpected error: %v", err)
	}
}
