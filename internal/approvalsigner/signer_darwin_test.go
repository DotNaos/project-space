//go:build darwin

package approvalsigner

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRejectsUnsignedReplacementHelper(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(filepath.Dir(executable), "project-approval-signer")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho fake\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	previousHash := expectedHelperSHA256
	expectedHelperSHA256 = hex.EncodeToString(digest[:])
	t.Cleanup(func() { expectedHelperSHA256 = previousHash })
	t.Cleanup(func() { _ = os.Remove(path) })
	_, err = runHelper("public-key")
	if err == nil || !strings.Contains(err.Error(), "not a trusted signed Project component") {
		t.Fatalf("error=%v", err)
	}
}

func TestRejectsHelperThatDoesNotMatchEmbeddedHash(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(filepath.Dir(executable), "project-approval-signer")
	if err := os.WriteFile(path, []byte("replacement"), 0o755); err != nil {
		t.Fatal(err)
	}
	previousHash := expectedHelperSHA256
	expectedHelperSHA256 = strings.Repeat("0", sha256.Size*2)
	t.Cleanup(func() {
		expectedHelperSHA256 = previousHash
		_ = os.Remove(path)
	})
	_, err = runHelper("public-key")
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("error=%v", err)
	}
}
