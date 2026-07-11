//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"testing"

	"github.com/DotNaos/project-space/internal/projectrun"
)

func TestServeCommandsExposeStableJSONContract(t *testing.T) {
	manager := &fakeProjectCommandManager{serveResult: runningServeFixture()}
	factory := func() (projectCommandManager, error) { return manager, nil }

	startOutput := executeProjectCommand(t, newServeCommandWithManager(factory), []string{
		"dev", "/tmp/worktree", "--json",
		"--allowed-host", "preview.example.com", "--allowed-host", "app.example.com",
	})
	assertServeJSONKeys(t, startOutput)
	if manager.startDirectory != "/tmp/worktree" || manager.startScript != "dev" ||
		!reflect.DeepEqual(manager.allowedHosts, []string{"preview.example.com", "app.example.com"}) {
		t.Fatalf("start call = directory %q script %q hosts %#v", manager.startDirectory, manager.startScript, manager.allowedHosts)
	}

	statusOutput := executeProjectCommand(t, newServeCommandWithManager(factory), []string{
		"status", "/tmp/worktree", "--script", "dev", "--format", "json",
	})
	assertServeJSONKeys(t, statusOutput)
	if manager.statusDirectory != "/tmp/worktree" || manager.statusScript != "dev" {
		t.Fatalf("status call = directory %q script %q", manager.statusDirectory, manager.statusScript)
	}

	stopOutput := executeProjectCommand(t, newServeCommandWithManager(factory), []string{
		"stop", "/tmp/worktree", "--script", "dev", "--json",
	})
	assertServeJSONKeys(t, stopOutput)
	if manager.stopDirectory != "/tmp/worktree" || manager.stopScript != "dev" {
		t.Fatalf("stop call = directory %q script %q", manager.stopDirectory, manager.stopScript)
	}
}

func TestServeFailureStillPrintsJSONBeforeReturningNonzero(t *testing.T) {
	result := runningServeFixture()
	result.State = projectrun.StateError
	message := "Tailscale unavailable"
	result.LastError = &message
	manager := &fakeProjectCommandManager{serveResult: result, startErr: errors.New(message)}
	cmd := newServeCommandWithManager(func() (projectCommandManager, error) { return manager, nil })
	cmd.SilenceUsage = true
	stdout := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(io.Discard)
	cmd.SetArgs([]string{"dev", "/tmp/worktree", "--json"})
	if err := cmd.Execute(); err == nil {
		t.Fatal("expected command failure")
	}
	assertServeJSONKeys(t, stdout.String())
}

func TestServeReconcileExposesStableJSONContract(t *testing.T) {
	manager := &fakeProjectCommandManager{reconcileResult: projectrun.ServeCollectionResult{
		SchemaVersion: 1,
		Operation:     "reconcile",
		CheckedAt:     "2026-07-11T12:00:01Z",
		Sessions:      []projectrun.ServeResult{runningServeFixture()},
	}}
	output := executeProjectCommand(t, newServeCommandWithManager(
		func() (projectCommandManager, error) { return manager, nil },
	), []string{"reconcile", "--json"})
	payload := map[string]any{}
	if err := json.Unmarshal([]byte(output), &payload); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, output)
	}
	for _, key := range []string{"schemaVersion", "operation", "checkedAt", "errorCount", "sessions"} {
		if _, exists := payload[key]; !exists {
			t.Fatalf("JSON is missing %q: %#v", key, payload)
		}
	}
	if manager.reconcileCalls != 1 {
		t.Fatalf("reconcile calls = %d", manager.reconcileCalls)
	}
}

func TestRunJSONKeepsChildOutputOffMachineReadableStdout(t *testing.T) {
	exitCode := 0
	manager := &fakeProjectCommandManager{runResult: projectrun.RunResult{
		SchemaVersion: 1,
		Operation:     "run",
		Script:        "test",
		Directory:     "/tmp/worktree",
		State:         "exited",
		Command:       []string{"go", "test", "./..."},
		LocalPort:     43117,
		LocalURL:      "http://127.0.0.1:43117",
		StartedAt:     "2026-07-11T12:00:00Z",
		FinishedAt:    "2026-07-11T12:00:01Z",
		ExitCode:      &exitCode,
	}}
	cmd := newRunCommandWithManager(func() (projectCommandManager, error) { return manager, nil })
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetArgs([]string{"test", "/tmp/worktree", "--json"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(stderr.Bytes(), []byte("child output")) {
		t.Fatalf("child output was not redirected to stderr: %q", stderr.String())
	}
	result := map[string]any{}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", err, stdout)
	}
	if result["operation"] != "run" || result["state"] != "exited" {
		t.Fatalf("run JSON = %#v", result)
	}
}

func executeProjectCommand(t *testing.T, cmd interface {
	SetOut(io.Writer)
	SetErr(io.Writer)
	SetArgs([]string)
	Execute() error
}, args []string) string {
	t.Helper()
	stdout := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	return stdout.String()
}

func assertServeJSONKeys(t *testing.T, output string) {
	t.Helper()
	payload := map[string]any{}
	if err := json.Unmarshal([]byte(output), &payload); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, output)
	}
	for _, key := range []string{
		"schemaVersion", "operation", "script", "directory", "capability", "state",
		"pid", "localPort", "localUrl", "publicPort", "publicUrl", "tailscaleIPv4",
		"allowedHosts", "startedAt", "checkedAt", "lastError",
	} {
		if _, exists := payload[key]; !exists {
			t.Fatalf("JSON is missing %q: %#v", key, payload)
		}
	}
}

type fakeProjectCommandManager struct {
	serveResult     projectrun.ServeResult
	reconcileResult projectrun.ServeCollectionResult
	runResult       projectrun.RunResult
	startErr        error
	startDirectory  string
	startScript     string
	allowedHosts    []string
	reconcileCalls  int
	statusDirectory string
	statusScript    string
	stopDirectory   string
	stopScript      string
}

func (manager *fakeProjectCommandManager) Run(
	_ context.Context,
	directory string,
	script string,
	streams projectrun.Streams,
) (projectrun.RunResult, error) {
	manager.runResult.Directory = directory
	manager.runResult.Script = script
	_, _ = io.WriteString(streams.Stdout, "child output\n")
	return manager.runResult, nil
}

func (manager *fakeProjectCommandManager) Start(
	_ context.Context,
	directory string,
	script string,
	allowedHosts []string,
) (projectrun.ServeResult, error) {
	manager.startDirectory, manager.startScript = directory, script
	manager.allowedHosts = append([]string{}, allowedHosts...)
	manager.serveResult.Operation = "start"
	return manager.serveResult, manager.startErr
}

func (manager *fakeProjectCommandManager) Status(
	_ context.Context,
	directory string,
	script string,
) (projectrun.ServeResult, error) {
	manager.statusDirectory, manager.statusScript = directory, script
	manager.serveResult.Operation = "status"
	return manager.serveResult, nil
}

func (manager *fakeProjectCommandManager) Stop(
	_ context.Context,
	directory string,
	script string,
) (projectrun.ServeResult, error) {
	manager.stopDirectory, manager.stopScript = directory, script
	manager.serveResult.Operation = "stop"
	return manager.serveResult, nil
}

func (manager *fakeProjectCommandManager) Reconcile(
	_ context.Context,
) (projectrun.ServeCollectionResult, error) {
	manager.reconcileCalls++
	return manager.reconcileResult, nil
}

func runningServeFixture() projectrun.ServeResult {
	pid, localPort, publicPort := 7001, 43117, 44419
	localURL, publicURL := "http://127.0.0.1:43117", "http://100.80.135.9:44419"
	ip, startedAt := "100.80.135.9", "2026-07-11T12:00:00Z"
	return projectrun.ServeResult{
		SchemaVersion: 1,
		Script:        "dev",
		Directory:     "/tmp/worktree",
		Capability:    projectrun.CapabilityConfigured,
		State:         projectrun.StateRunning,
		PID:           &pid,
		LocalPort:     &localPort,
		LocalURL:      &localURL,
		PublicPort:    &publicPort,
		PublicURL:     &publicURL,
		TailscaleIPv4: &ip,
		AllowedHosts:  []string{"app.example.com"},
		StartedAt:     &startedAt,
		CheckedAt:     "2026-07-11T12:00:01Z",
	}
}
