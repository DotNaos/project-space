//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/workspacerun"
)

func TestWorkspaceRuntimeExposesEveryLifecycleOperation(t *testing.T) {
	command := newWorkspaceCommandWithManager(func() (workspaceRuntimeManager, error) {
		return &fakeWorkspaceRuntimeManager{}, nil
	})
	runtimeCommand, _, err := command.Find([]string{"runtime"})
	if err != nil {
		t.Fatalf("find workspace runtime command: %v", err)
	}
	got := make([]string, 0, len(runtimeCommand.Commands()))
	for _, child := range runtimeCommand.Commands() {
		got = append(got, child.Name())
	}
	want := []string{"clean", "inspect", "reconcile", "resume", "start", "stop", "suspend"}
	if !slices.Equal(got, want) {
		t.Fatalf("workspace runtime commands = %q, want %q", got, want)
	}
}

func TestWorkspaceRuntimeDispatchesEveryOperationWithExactFences(t *testing.T) {
	const (
		directory          = "/tmp/exact-worktree"
		expectedCommit     = "0123456789abcdef0123456789abcdef01234567"
		expectedDigest     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		expectedGeneration = "123e4567-e89b-42d3-a456-426614174000"
		threadID           = "019ff2a1-7f21-7f22-98c9-f47c47b4238b"
	)

	for _, operation := range []string{"start", "inspect", "suspend", "resume", "stop", "clean", "reconcile"} {
		t.Run(operation, func(t *testing.T) {
			manager := &fakeWorkspaceRuntimeManager{result: workspaceRuntimeResultFixture(operation)}
			command := newWorkspaceCommandWithManager(func() (workspaceRuntimeManager, error) {
				return manager, nil
			})
			stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
			command.SetOut(stdout)
			command.SetErr(stderr)
			command.SetArgs([]string{
				"runtime", operation, directory,
				"--mode", "devcontainer",
				"--expected-commit", expectedCommit,
				"--expected-digest", expectedDigest,
				"--expected-generation", expectedGeneration,
				"--thread-id", threadID,
				"--json",
			})
			if err := command.Execute(); err != nil {
				t.Fatalf("execute workspace runtime %s: %v", operation, err)
			}

			if manager.operation != operation {
				t.Fatalf("dispatched operation = %q, want %q", manager.operation, operation)
			}
			if manager.directory != directory {
				t.Fatalf("directory = %q, want %q", manager.directory, directory)
			}
			wantOptions := workspacerun.OperationOptions{
				Mode:               workspacerun.ModeDevcontainer,
				ExpectedCommit:     expectedCommit,
				ExpectedDigest:     expectedDigest,
				ExpectedGeneration: expectedGeneration,
				ThreadID:           threadID,
			}
			if !reflect.DeepEqual(manager.options, wantOptions) {
				t.Fatalf("operation options = %#v, want %#v", manager.options, wantOptions)
			}

			assertWorkspaceRuntimeJSON(t, stdout.Bytes(), operation)
			if operation == "start" || operation == "stop" {
				if !strings.Contains(stderr.String(), "runtime progress") {
					t.Fatalf("%s progress was not redirected to stderr: %q", operation, stderr.String())
				}
			} else if stderr.Len() != 0 {
				t.Fatalf("unexpected %s stderr: %q", operation, stderr.String())
			}
		})
	}
}

func TestWorkspaceRuntimeDefaultsToCurrentDirectoryAndPrettyOutput(t *testing.T) {
	manager := &fakeWorkspaceRuntimeManager{result: workspaceRuntimeResultFixture("inspect")}
	command := newWorkspaceCommandWithManager(func() (workspaceRuntimeManager, error) {
		return manager, nil
	})
	stdout := &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(io.Discard)
	command.SetArgs([]string{"runtime", "inspect"})
	if err := command.Execute(); err != nil {
		t.Fatalf("execute workspace runtime inspect: %v", err)
	}
	if manager.directory != "." {
		t.Fatalf("default directory = %q, want current directory", manager.directory)
	}
	for _, line := range []string{
		"Workspace: ws_0123456789abcdef01234567",
		"Generation: 123e4567-e89b-42d3-a456-426614174000",
		"State: running",
		"Mode: process",
		"Manifest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	} {
		if !strings.Contains(stdout.String(), line+"\n") {
			t.Fatalf("pretty output is missing %q:\n%s", line, stdout.String())
		}
	}
}

func TestWorkspaceRuntimeFailurePrintsJSONBeforeReturningError(t *testing.T) {
	manager := &fakeWorkspaceRuntimeManager{
		result: workspaceRuntimeResultFixture("reconcile"),
		err:    errors.New("runtime ownership could not be proven"),
	}
	command := newWorkspaceCommandWithManager(func() (workspaceRuntimeManager, error) {
		return manager, nil
	})
	command.SilenceUsage = true
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command.SetOut(stdout)
	command.SetErr(stderr)
	command.SetArgs([]string{"runtime", "reconcile", "/tmp/exact-worktree", "--json"})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "ownership could not be proven") {
		t.Fatalf("error = %v, want safe ownership failure", err)
	}
	assertWorkspaceRuntimeJSON(t, stdout.Bytes(), "reconcile")
	for _, unsafe := range []string{"ownershipToken", "credential", "secret", "accessToken"} {
		if strings.Contains(stdout.String(), unsafe) || strings.Contains(stderr.String(), unsafe) || strings.Contains(err.Error(), unsafe) {
			t.Fatalf("failure output exposed forbidden field %q: stdout=%q stderr=%q error=%q", unsafe, stdout, stderr, err)
		}
	}
}

func TestWorkspaceRuntimeRejectsUnsafeOrInvalidFlagsBeforeManagerCreation(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		message string
		secret  string
	}{
		{name: "unknown output format", args: []string{"runtime", "start", "--format", "yaml"}, message: "unknown format"},
		{name: "extra directory", args: []string{"runtime", "start", "/tmp/one", "/tmp/two"}, message: "accepts at most 1 arg"},
		{name: "no token flag", args: []string{"runtime", "start", "--token", "do-not-print-this-token"}, message: "unknown flag: --token", secret: "do-not-print-this-token"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			factoryCalls := 0
			command := newWorkspaceCommandWithManager(func() (workspaceRuntimeManager, error) {
				factoryCalls++
				return &fakeWorkspaceRuntimeManager{}, nil
			})
			command.SilenceUsage = true
			stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
			command.SetOut(stdout)
			command.SetErr(stderr)
			command.SetArgs(test.args)
			err := command.Execute()
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("error = %v, want %q", err, test.message)
			}
			if factoryCalls != 0 {
				t.Fatalf("manager factory calls = %d, want 0", factoryCalls)
			}
			if test.secret != "" && (strings.Contains(stdout.String(), test.secret) || strings.Contains(stderr.String(), test.secret) || strings.Contains(err.Error(), test.secret)) {
				t.Fatalf("rejected token value was echoed: stdout=%q stderr=%q error=%q", stdout, stderr, err)
			}
		})
	}
}

func workspaceRuntimeResultFixture(operation string) workspacerun.Result {
	pid := 4242
	port := 43117
	url := "http://127.0.0.1:43117"
	startedAt := "2026-08-12T08:00:00Z"
	return workspacerun.Result{
		SchemaVersion:  workspacerun.SchemaVersion,
		Operation:      operation,
		Disposition:    workspacerun.DispositionCreated,
		WorkspaceID:    "ws_0123456789abcdef01234567",
		Generation:     "123e4567-e89b-42d3-a456-426614174000",
		Directory:      "/tmp/exact-worktree",
		Repository:     "https://github.com/DotNaos/project-space.git",
		ManifestDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		SourceHead:     "0123456789abcdef0123456789abcdef01234567",
		Mode:           workspacerun.ModeProcess,
		State:          workspacerun.StateRunning,
		PID:            &pid,
		Resources:      workspacerun.ResourceLimits{CPUMillis: 1000, MemoryMiB: 1024, PIDs: 64},
		DevServers: []workspacerun.ManagedDevServer{{
			Name: "web", ServerID: "server-1", TmuxSession: "project-web", State: "running",
			LocalPort: &port, LocalURL: &url,
		}},
		StartedAt: &startedAt,
		CheckedAt: "2026-08-12T08:00:01Z",
	}
}

func assertWorkspaceRuntimeJSON(t *testing.T, output []byte, operation string) {
	t.Helper()
	payload := map[string]any{}
	decoder := json.NewDecoder(bytes.NewReader(output))
	if err := decoder.Decode(&payload); err != nil {
		t.Fatalf("invalid Workspace runtime JSON: %v\n%s", err, output)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("Workspace runtime stdout contains more than one JSON value: %v\n%s", err, output)
	}
	for _, key := range []string{
		"schemaVersion", "operation", "disposition", "workspaceId", "generation", "directory",
		"repository", "manifestDigest", "sourceHead", "mode", "state", "pid", "resources",
		"devServers", "startedAt", "checkedAt",
	} {
		if _, exists := payload[key]; !exists {
			t.Fatalf("Workspace runtime JSON is missing %q: %#v", key, payload)
		}
	}
	if payload["operation"] != operation || payload["workspaceId"] != "ws_0123456789abcdef01234567" || payload["state"] != "running" {
		t.Fatalf("Workspace runtime JSON = %#v", payload)
	}
	for _, forbidden := range []string{"ownershipToken", "credential", "secret", "accessToken"} {
		if _, exists := payload[forbidden]; exists {
			t.Fatalf("Workspace runtime JSON exposed forbidden key %q: %#v", forbidden, payload)
		}
	}
}

type fakeWorkspaceRuntimeManager struct {
	result    workspacerun.Result
	err       error
	operation string
	directory string
	options   workspacerun.OperationOptions
}

func (manager *fakeWorkspaceRuntimeManager) capture(operation, directory string, options workspacerun.OperationOptions) (workspacerun.Result, error) {
	manager.operation = operation
	manager.directory = directory
	manager.options = options
	return manager.result, manager.err
}

func (manager *fakeWorkspaceRuntimeManager) Start(_ context.Context, directory string, options workspacerun.OperationOptions, streams workspacerun.Streams) (workspacerun.Result, error) {
	_, _ = io.WriteString(streams.Out, "runtime progress\n")
	return manager.capture("start", directory, options)
}

func (manager *fakeWorkspaceRuntimeManager) Inspect(_ context.Context, directory string, options workspacerun.OperationOptions) (workspacerun.Result, error) {
	return manager.capture("inspect", directory, options)
}

func (manager *fakeWorkspaceRuntimeManager) Suspend(_ context.Context, directory string, options workspacerun.OperationOptions) (workspacerun.Result, error) {
	return manager.capture("suspend", directory, options)
}

func (manager *fakeWorkspaceRuntimeManager) Resume(_ context.Context, directory string, options workspacerun.OperationOptions) (workspacerun.Result, error) {
	return manager.capture("resume", directory, options)
}

func (manager *fakeWorkspaceRuntimeManager) Stop(_ context.Context, directory string, options workspacerun.OperationOptions, streams workspacerun.Streams) (workspacerun.Result, error) {
	_, _ = io.WriteString(streams.Out, "runtime progress\n")
	return manager.capture("stop", directory, options)
}

func (manager *fakeWorkspaceRuntimeManager) Clean(_ context.Context, directory string, options workspacerun.OperationOptions) (workspacerun.Result, error) {
	return manager.capture("clean", directory, options)
}

func (manager *fakeWorkspaceRuntimeManager) Reconcile(_ context.Context, directory string, options workspacerun.OperationOptions) (workspacerun.Result, error) {
	return manager.capture("reconcile", directory, options)
}
