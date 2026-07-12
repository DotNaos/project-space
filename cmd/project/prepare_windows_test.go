//go:build windows

package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestWindowsPrepareCommandsKeepStableShape(t *testing.T) {
	prepare := newPrepareCommand()
	assertWindowsRuntimeFlags(t, prepare, "format", "json", "step")

	status, _, err := prepare.Find([]string{"status"})
	if err != nil {
		t.Fatalf("find prepare status: %v", err)
	}
	if status.Name() != "status" {
		t.Fatalf("prepare child = %q, want status", status.Name())
	}
	assertWindowsRuntimeFlags(t, status, "format", "json", "step")
}

func TestWindowsPrepareCommandsPointToConfiguredWSLDistribution(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
	}{
		{name: "prepare"},
		{name: "prepare status", args: []string{"status"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := newPrepareCommand()
			output := &bytes.Buffer{}
			command.SetOut(output)
			command.SetErr(output)
			command.SetArgs(test.args)
			err := command.Execute()
			if err == nil {
				t.Fatal("expected unsupported-platform error")
			}
			for _, fragment := range []string{
				"native Windows CLI",
				"installed WSL distribution",
				"wsl.exe --distribution <distribution> -- project prepare",
			} {
				if !strings.Contains(err.Error(), fragment) {
					t.Fatalf("error %q does not contain %q", err, fragment)
				}
			}
		})
	}
}
