package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConnectorCommandIsOnlyPredictableRetirementResponse(t *testing.T) {
	command := newConnectorCommand()
	if len(command.Commands()) != 0 {
		t.Fatalf("retired connector still exposes subcommands: %#v", command.Commands())
	}
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetArgs([]string{"--json"})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "canonical_runtime_required") {
		t.Fatalf("retired connector error = %v", err)
	}
	response := map[string]string{}
	if decodeErr := json.Unmarshal(output.Bytes(), &response); decodeErr != nil {
		t.Fatalf("decode retirement response: %v", decodeErr)
	}
	if response["code"] != "canonical_runtime_required" ||
		response["replacement"] != "project environment bootstrap" {
		t.Fatalf("retirement response = %#v", response)
	}
}

func TestResolveAuthenticatedCodexHostBinaryFindsPhysicalSibling(t *testing.T) {
	directory := t.TempDir()
	projectExecutable := filepath.Join(directory, projectExecutableName(runtime.GOOS))
	if err := os.WriteFile(projectExecutable, []byte("project"), 0o700); err != nil {
		t.Fatal(err)
	}
	hostName := "project-codex-host"
	if runtime.GOOS == "windows" {
		hostName += ".exe"
	}
	host := filepath.Join(directory, hostName)
	if err := os.WriteFile(host, []byte("codex host"), 0o700); err != nil {
		t.Fatal(err)
	}
	resolved, err := resolveAuthenticatedCodexHostBinary(projectExecutable, runtime.GOOS)
	if err != nil {
		t.Fatal(err)
	}
	physicalHost, err := filepath.EvalSymlinks(host)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != physicalHost {
		t.Fatalf("resolved Codex host = %q, want %q", resolved, physicalHost)
	}
}

func TestResolveAuthenticatedCodexHostBinaryRejectsSymlinkedSibling(t *testing.T) {
	directory := t.TempDir()
	projectExecutable := filepath.Join(directory, projectExecutableName(runtime.GOOS))
	if err := os.WriteFile(projectExecutable, []byte("project"), 0o700); err != nil {
		t.Fatal(err)
	}
	hostName := "project-codex-host"
	if runtime.GOOS == "windows" {
		hostName += ".exe"
	}
	outside := filepath.Join(t.TempDir(), hostName)
	if err := os.WriteFile(outside, []byte("outside"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(directory, hostName)); err != nil {
		t.Skipf("create symlink: %v", err)
	}
	if resolved, err := resolveAuthenticatedCodexHostBinary(projectExecutable, runtime.GOOS); err == nil {
		t.Fatalf("resolved symlinked Codex host %q", resolved)
	}
}

func projectExecutableName(goos string) string {
	if goos == "windows" {
		return "project.exe"
	}
	return "project"
}
