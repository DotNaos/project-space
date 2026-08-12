package main

import (
	"bytes"
	"os"
	"slices"
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

func TestRootCommandIncludesExpectedCommands(t *testing.T) {
	want := []string{
		"__docs-model",
		"__runtime-supervisor",
		"__runtime-tmux",
		"__workspace-runtime-idle",
		"__workspace-runtime-session",
		"adopt",
		"agent",
		"chat",
		"codex",
		"connect",
		"connector",
		"control",
		"control-gateway",
		"create",
		"deploy",
		"dev-build",
		"disconnect",
		"doctor",
		"environment",
		"host",
		"init",
		"inventory",
		"list",
		"machine",
		"module",
		"open",
		"path",
		"platform",
		"prepare",
		"roadmap",
		"run",
		"self-update",
		"serve",
		"status",
		"template",
		"token",
		"validate",
		"workspace",
		"worktree",
	}
	root := newRootCommand()
	got := make([]string, 0, len(root.Commands()))
	for _, command := range root.Commands() {
		got = append(got, command.Name())
	}
	if !slices.Equal(got, want) {
		t.Fatalf("root commands = %q, want %q", got, want)
	}
}

func TestRootCommandHelpListsMachineConnectionCommands(t *testing.T) {
	command := newRootCommand()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs([]string{"--help"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute root help: %v", err)
	}
	for _, name := range []string{"connect", "disconnect", "doctor", "status"} {
		if !strings.Contains(output.String(), "  "+name+" ") {
			t.Errorf("root help does not list %q:\n%s", name, output.String())
		}
	}
}

func TestRootCommandPrintsBuildVersion(t *testing.T) {
	previousVersion := projectMachineClientVersion
	projectMachineClientVersion = "0.3.0-test"
	t.Cleanup(func() { projectMachineClientVersion = previousVersion })

	command := newRootCommand()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs([]string{"--version"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute root version: %v", err)
	}
	if !strings.Contains(output.String(), "0.3.0-test") {
		t.Fatalf("root version output = %q", output.String())
	}
}

func TestRootCommandRejectsRetiredConnectorCommands(t *testing.T) {
	command := newRootCommand()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs([]string{"connector", "install", "--json"})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "canonical_runtime_required") {
		t.Fatalf("connector retirement error = %v", err)
	}
	if !strings.Contains(output.String(), `"replacement":"project environment bootstrap"`) {
		t.Fatalf("connector retirement output = %q", output.String())
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
