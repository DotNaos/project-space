package main

import (
	"bytes"
	"os"
	"path/filepath"
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
		"adopt",
		"agent",
		"approval",
		"chat",
		"codex",
		"connect",
		"connector",
		"create",
		"deploy",
		"dev-build",
		"disconnect",
		"doctor",
		"init",
		"list",
		"machine",
		"module",
		"open",
		"path",
		"prepare",
		"roadmap",
		"run",
		"self-update",
		"serve",
		"status",
		"template",
		"token",
		"validate",
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

func TestRootCommandKeepsConnectorRunDiscoverable(t *testing.T) {
	command, _, err := newRootCommand().Find([]string{"connector", "run"})
	if err != nil {
		t.Fatalf("Find(connector run) error: %v", err)
	}
	if command.CommandPath() != "project connector run" {
		t.Fatalf("command path = %q, want project connector run", command.CommandPath())
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

func TestCreateGitHubMaterializesDefaultModulesBeforeRepositoryCreation(t *testing.T) {
	templateRoot := filepath.Join(t.TempDir(), "template")
	writeCreateCommandTestFile(t, filepath.Join(templateRoot, ".templateignore"), ".templateignore\ntemplate/**\n")
	writeCreateCommandTestFile(t, filepath.Join(templateRoot, "template", "manifest.yaml"), "name: project-template\nversion: 0.1.0\nmodules:\n  - modules/core.yaml\n")
	writeCreateCommandTestFile(t, filepath.Join(templateRoot, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nowns:\n  - .github/rulesets/default-branch.json\n")
	writeCreateCommandTestFile(t, filepath.Join(templateRoot, ".github.template", "rulesets", "default-branch.json"), "{\"name\":\"Protect default branch\"}\n")

	original := createGitHubRepositoryForCommand
	t.Cleanup(func() { createGitHubRepositoryForCommand = original })
	called := false
	createGitHubRepositoryForCommand = func(projectRoot string, _ createGitHubRepositoryOptions) (createGitHubRepositoryResult, error) {
		called = true
		body, err := os.ReadFile(filepath.Join(projectRoot, ".github", "rulesets", "default-branch.json"))
		if err != nil {
			t.Fatalf("ruleset was not materialized before GitHub creation: %v", err)
		}
		if string(body) != "{\"name\":\"Protect default branch\"}\n" {
			t.Fatalf("materialized ruleset = %q", string(body))
		}
		return createGitHubRepositoryResult{URL: "https://github.com/DotNaos/generated-app"}, nil
	}

	target := filepath.Join(t.TempDir(), "generated-app")
	cmd := newRootCommand()
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"create", target, "--template-path", templateRoot, "--github"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute GitHub create: %v", err)
	}
	if !called {
		t.Fatal("GitHub repository creation was not invoked")
	}
}

func writeCreateCommandTestFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
