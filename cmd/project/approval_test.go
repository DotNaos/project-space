package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApprovalVerifyFailsClosedWithoutExternalTrustRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".project", "approvals"), 0o755); err != nil {
		t.Fatal(err)
	}
	policy := "version: 1\nrepository: example/repo\npolicyId: review\nscopes:\n  - id: source\n    label: Source\n    paths: [README.md]\n    attestation: .project/approvals/source.json\n"
	if err := os.WriteFile(filepath.Join(root, ".project", "approvals", "policy.yaml"), []byte(policy), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("review\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	command := newRootCommand()
	command.SetArgs([]string{"approval", "verify", "--root", root, "--trust-root", filepath.Join(root, "missing.json")})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "external trust root") {
		t.Fatalf("verify error = %v", err)
	}
}

func TestApprovalStatusRejectsUnknownFormat(t *testing.T) {
	command := newRootCommand()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"approval", "status", "--format", "yaml", "--trust-root", "/tmp/trust.json"})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "--format") {
		t.Fatalf("status error = %v", err)
	}
}
