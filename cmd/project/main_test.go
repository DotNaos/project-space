package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCreateSecretsRequiresGitHub(t *testing.T) {
	cmd := newRootCommand()
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetArgs([]string{"create", "my-app", "--secrets"})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "--secrets requires --github") {
		t.Fatalf("unexpected error: %v", err)
	}
}
