//go:build windows

package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestWindowsRuntimeCommandsKeepStableShape(t *testing.T) {
	run := newRunCommand()
	assertWindowsRuntimeFlags(t, run, "format", "json")

	serve := newServeCommand()
	assertWindowsRuntimeFlags(t, serve, "allowed-host", "format", "json")
	for _, test := range []struct {
		name  string
		flags []string
	}{
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

func TestWindowsRuntimeCommandsPointToWSL(t *testing.T) {
	for _, test := range []struct {
		name string
		cmd  *cobra.Command
		args []string
	}{
		{name: "run", cmd: newRunCommand(), args: []string{"test"}},
		{name: "serve", cmd: newServeCommand(), args: []string{}},
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
			for _, fragment := range []string{"native Windows CLI", "WSL (Ubuntu)", "wsl.exe --distribution Ubuntu -- project"} {
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
