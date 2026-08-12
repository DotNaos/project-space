//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestWindowsRuntimeCommandsKeepStableShape(t *testing.T) {
	run := newRunCommand()
	assertWindowsRuntimeFlags(t, run, "format", "json")

	serve := newServeCommand()
	assertWindowsRuntimeFlags(t, serve, "allowed-host", "apis", "data", "format", "json", "local-only", "tailnet")
	for _, test := range []struct {
		name  string
		flags []string
	}{
		{name: "list", flags: []string{"format", "json"}},
		{name: "reconcile", flags: []string{"format", "json"}},
		{name: "status", flags: []string{"format", "json", "script"}},
		{name: "stop", flags: []string{"format", "json", "script"}},
	} {
		child, _, err := serve.Find([]string{test.name})
		if err != nil {
			t.Fatalf("find serve %s: %v", test.name, err)
		}
		if child.Name() != test.name {
			t.Fatalf("serve child = %q, want %q", child.Name(), test.name)
		}
		assertWindowsRuntimeFlags(t, child, test.flags...)
	}

	supervisor := newRuntimeLogCommand()
	if supervisor.Name() != "__runtime-supervisor" || !supervisor.Hidden {
		t.Fatalf("supervisor = name %q hidden %t", supervisor.Name(), supervisor.Hidden)
	}
}

func TestWindowsWorkspaceRuntimeCommandsKeepShapeAndPointToWSL(t *testing.T) {
	for _, operation := range []string{"start", "inspect", "suspend", "resume", "stop", "clean", "reconcile"} {
		workspace := newWorkspaceCommand()
		runtimeCommand, _, err := workspace.Find([]string{"runtime"})
		if err != nil {
			t.Fatalf("find workspace runtime: %v", err)
		}
		command, _, err := runtimeCommand.Find([]string{operation})
		if err != nil {
			t.Fatalf("find workspace runtime %s: %v", operation, err)
		}
		assertWindowsRuntimeFlags(
			t, command, "expected-commit", "expected-digest", "expected-generation", "format", "json", "mode", "thread-id",
		)
		workspace.SetArgs([]string{"runtime", operation})
		err = workspace.Execute()
		if err == nil || !strings.Contains(err.Error(), "installed WSL distribution") {
			t.Fatalf("workspace runtime %s error = %v", operation, err)
		}
	}
}

func TestWindowsControlHandshakeAdvertisesOnlyOwnerSideStatus(t *testing.T) {
	command := newControlCommandWithDependencies(controlCommandDependencies{})
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs([]string{"handshake"})
	if err := command.Execute(); err != nil {
		t.Fatalf("control handshake: %v", err)
	}
	var handshake controlHandshakeResult
	if err := json.Unmarshal(output.Bytes(), &handshake); err != nil {
		t.Fatalf("decode control handshake: %v", err)
	}
	if !reflect.DeepEqual(handshake.Operations, []string{"status.v1"}) {
		t.Fatalf("operations = %v, want owner-side status only", handshake.Operations)
	}
}

func TestWindowsRuntimeCommandsPointToWSL(t *testing.T) {
	for _, test := range []struct {
		name string
		cmd  *cobra.Command
		args []string
	}{
		{name: "run", cmd: newRunCommand(), args: []string{"test"}},
		{name: "serve", cmd: newServeCommand(), args: []string{}},
		{name: "serve list", cmd: newServeCommand(), args: []string{"list"}},
		{name: "serve reconcile", cmd: newServeCommand(), args: []string{"reconcile"}},
		{name: "serve status", cmd: newServeCommand(), args: []string{"status"}},
		{name: "serve stop", cmd: newServeCommand(), args: []string{"stop"}},
		{name: "runtime supervisor", cmd: newRuntimeLogCommand(), args: []string{"runtime.log"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			output := &bytes.Buffer{}
			test.cmd.SetOut(output)
			test.cmd.SetErr(output)
			test.cmd.SetArgs(test.args)
			err := test.cmd.Execute()
			if err == nil {
				t.Fatal("expected unsupported-platform error")
			}
			for _, fragment := range []string{"native Windows CLI", "installed WSL distribution", "wsl.exe --distribution <distribution> -- project"} {
				if !strings.Contains(err.Error(), fragment) {
					t.Fatalf("error %q does not contain %q", err, fragment)
				}
			}
		})
	}
}

func assertWindowsRuntimeFlags(t *testing.T, cmd *cobra.Command, names ...string) {
	t.Helper()
	for _, name := range names {
		if cmd.Flags().Lookup(name) == nil {
			t.Errorf("%s is missing --%s", cmd.CommandPath(), name)
		}
	}
}
