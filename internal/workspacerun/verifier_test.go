package workspacerun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExactToolVerifierAcceptsOnlyMatchingVersionAndExecutableDigest(t *testing.T) {
	bin := t.TempDir()
	projectPath := writeVersionTool(t, bin, ToolProject, "project 1.2.3")
	writeVersionTool(t, bin, ToolCodex, "codex-cli 2.3.4")
	t.Setenv("PATH", bin)

	manifest := Manifest{
		ProjectRuntime: pinForTool(t, projectPath, ToolProject, "1.2.3"),
		Codex:          pinForTool(t, filepath.Join(bin, string(ToolCodex)), ToolCodex, "2.3.4"),
	}
	verified, err := (ExactToolVerifier{}).Verify(context.Background(), manifest)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(projectPath)
	if err != nil {
		t.Fatal(err)
	}
	if verified.ProjectBinary != resolved {
		t.Fatalf("ProjectBinary = %q, want %q", verified.ProjectBinary, resolved)
	}
}

func TestExactToolVerifierRejectsChecksumAndVersionDrift(t *testing.T) {
	bin := t.TempDir()
	projectPath := writeVersionTool(t, bin, ToolProject, "project 1.2.3")
	codexPath := writeVersionTool(t, bin, ToolCodex, "codex-cli 2.3.4")
	t.Setenv("PATH", bin)
	base := Manifest{
		ProjectRuntime: pinForTool(t, projectPath, ToolProject, "1.2.3"),
		Codex:          pinForTool(t, codexPath, ToolCodex, "2.3.4"),
	}

	checksumDrift := base
	checksumDrift.ProjectRuntime.SHA256 = strings.Repeat("f", 64)
	if _, err := (ExactToolVerifier{}).Verify(context.Background(), checksumDrift); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("checksum error = %v", err)
	}

	versionDrift := base
	versionDrift.Codex.Version = "2.3.5"
	if _, err := (ExactToolVerifier{}).Verify(context.Background(), versionDrift); err == nil || !strings.Contains(err.Error(), "version mismatch") {
		t.Fatalf("version error = %v", err)
	}
}

func writeVersionTool(t *testing.T, directory string, id ToolID, output string) string {
	t.Helper()
	path := filepath.Join(directory, string(id))
	body := "#!/bin/sh\nprintf '%s\\n' '" + output + "'\n"
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func pinForTool(t *testing.T, path string, id ToolID, version string) ToolPin {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	return ToolPin{ID: id, Version: version, SHA256: hex.EncodeToString(digest[:])}
}
