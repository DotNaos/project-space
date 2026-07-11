package main

import (
	"bytes"
	"os"
	"strings"
	"syscall"
	"testing"
)

func TestProjectTerminationSignalsIncludeHangup(t *testing.T) {
	wanted := map[os.Signal]bool{
		os.Interrupt:    false,
		syscall.SIGTERM: false,
		syscall.SIGHUP:  false,
	}
	for _, signal := range projectTerminationSignals() {
		if _, exists := wanted[signal]; exists {
			wanted[signal] = true
		}
	}
	for signal, found := range wanted {
		if !found {
			t.Fatalf("termination signal %v is not registered", signal)
		}
	}
}

func TestRootCommandIncludesProjectChat(t *testing.T) {
	command, _, err := newRootCommand().Find([]string{"chat"})
	if err != nil {
		t.Fatalf("Find(chat) error: %v", err)
	}
	if command.Name() != "chat" {
		t.Fatalf("command name = %q, want chat", command.Name())
	}
}

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
