//go:build !windows

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/projectrun"
)

func TestPrepareCommandsExposeStableJSONContract(t *testing.T) {
	manager := &fakeProjectCommandManager{setupResult: setupCollectionFixture("prepare")}
	factory := func() (projectCommandManager, error) { return manager, nil }
	command := newPrepareCommandWithManager(factory)
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)
	command.SetArgs([]string{"/tmp/worktree", "--step", "dependencies", "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	assertSetupJSONKeys(t, stdout.Bytes())
	if manager.prepareCalls != 1 || manager.setupDirectory != "/tmp/worktree" || manager.setupStep != "dependencies" {
		t.Fatalf("unexpected prepare call: directory=%q step=%q calls=%d", manager.setupDirectory, manager.setupStep, manager.prepareCalls)
	}
	if bytes.Contains(stderr.Bytes(), []byte("setup child output")) {
		t.Fatalf("JSON mode exposed child output: %q", stderr)
	}

	manager.setupResult = setupCollectionFixture("status")
	stdout.Reset()
	status := newPrepareStatusCommand(factory)
	status.SetOut(stdout)
	status.SetErr(io.Discard)
	status.SetArgs([]string{"/tmp/worktree", "--step", "dependencies", "--json"})
	if err := status.Execute(); err != nil {
		t.Fatal(err)
	}
	assertSetupJSONKeys(t, stdout.Bytes())
	if manager.setupStatusCalls != 1 {
		t.Fatalf("status calls = %d", manager.setupStatusCalls)
	}
}

func TestPrepareCommandPassesApprovedSetupIdentityTogether(t *testing.T) {
	manager := &fakeProjectCommandManager{setupResult: setupCollectionFixture("prepare")}
	command := newPrepareCommandWithManager(func() (projectCommandManager, error) { return manager, nil })
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	command.SetArgs([]string{
		"/tmp/worktree", "--step", "dependencies", "--format", "json",
		"--expect-commit", strings.Repeat("a", 40),
		"--expect-declaration-digest", strings.Repeat("b", 64),
	})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if manager.setupExpected.Commit != strings.Repeat("a", 40) ||
		manager.setupExpected.DeclarationDigest != strings.Repeat("b", 64) {
		t.Fatalf("approved identity = %#v", manager.setupExpected)
	}

	missingPair := newPrepareCommandWithManager(func() (projectCommandManager, error) { return manager, nil })
	missingPair.SetOut(io.Discard)
	missingPair.SetErr(io.Discard)
	missingPair.SetArgs([]string{"--expect-commit", strings.Repeat("a", 40)})
	if err := missingPair.Execute(); err == nil {
		t.Fatal("expected incomplete approved identity flags to fail")
	}
}

func TestServeListJSONExposesOnlySafeInventory(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".project"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte("version: 2\nsetup:\n  - id: dependencies\n    command: [bun, install]\nservers:\n  dev:\n    label: Web app\n    command: [bun, run, dev]\n")
	if err := os.WriteFile(filepath.Join(project, ".project", "scripts.yaml"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	command := newServeListCommand(defaultProjectManager)
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(io.Discard)
	command.SetArgs([]string{project, "--configured", "--format", "json"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{}
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, stdout)
	}
	for _, key := range []string{"schemaVersion", "operation", "directory", "capability", "servers", "checkedAt", "lastError"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("missing %q: %#v", key, payload)
		}
	}
	for _, forbidden := range []string{"bun", "command", "healthCheck"} {
		if bytes.Contains(stdout.Bytes(), []byte(forbidden)) {
			t.Fatalf("inventory leaked %q: %s", forbidden, stdout)
		}
	}
}

func assertSetupJSONKeys(t *testing.T, body []byte) {
	t.Helper()
	payload := map[string]any{}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, body)
	}
	for _, key := range []string{"schemaVersion", "operation", "directory", "capability", "steps", "checkedAt", "lastError"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("missing %q: %#v", key, payload)
		}
	}
	steps, ok := payload["steps"].([]any)
	if !ok || len(steps) != 1 {
		t.Fatalf("steps = %#v", payload["steps"])
	}
	step := steps[0].(map[string]any)
	for _, key := range []string{"schemaVersion", "operation", "stepId", "directory", "capability", "state", "commit", "declarationDigest", "startedAt", "finishedAt", "checkedAt", "lastError"} {
		if _, ok := step[key]; !ok {
			t.Fatalf("step missing %q: %#v", key, step)
		}
	}
}

func setupCollectionFixture(operation string) projectrun.SetupCollectionResult {
	started, finished := "2026-07-12T01:02:03Z", "2026-07-12T01:03:03Z"
	return projectrun.SetupCollectionResult{
		SchemaVersion: 1, Operation: operation, Directory: "/tmp/worktree",
		Capability: projectrun.CapabilityConfigured, CheckedAt: finished,
		Steps: []projectrun.SetupResult{{
			SchemaVersion: 1, Operation: operation, StepID: "dependencies", Directory: "/tmp/worktree",
			Capability: projectrun.CapabilityConfigured, State: projectrun.SetupReady,
			Commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", DeclarationDigest: "digest",
			StartedAt: &started, FinishedAt: &finished, CheckedAt: finished,
		}},
	}
}
