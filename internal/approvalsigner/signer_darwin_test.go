//go:build darwin

package approvalsigner

import (
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
	t.Cleanup(func() { _ = os.Remove(path) })
	_, err = runHelper("public-key")
	if err == nil || !strings.Contains(err.Error(), "not a trusted signed Project component") {
		t.Fatalf("error=%v", err)
	}
}
