package machineconnect

import (
	"io"
	"os"
	"strings"
	"testing"
)

func TestConnectorSupervisorCommandCopiesValidatedArguments(t *testing.T) {
	arguments := []string{"connector", "source", "companion", "--root", "/tmp/project-space"}
	supervisor, err := NewConnectorSupervisorCommand(
		newSupervisorTestStore(t, supervisorCredential(t), nil),
		ConnectorSupervisorOptions{CodexOperationSnapshotPath: testCodexOperationSnapshotPath(t), Executable: os.Args[0], Stdout: io.Discard, Stderr: io.Discard},
		arguments,
	)
	if err != nil {
		t.Fatalf("create connector supervisor command: %v", err)
	}
	arguments[0] = "mutated"
	if supervisor.arguments[0] != "connector" {
		t.Fatalf("supervisor retained mutable arguments: %#v", supervisor.arguments)
	}
}

func TestConnectorSupervisorCommandRejectsUnsafeArguments(t *testing.T) {
	store := newSupervisorTestStore(t, supervisorCredential(t), nil)
	options := ConnectorSupervisorOptions{CodexOperationSnapshotPath: testCodexOperationSnapshotPath(t), Executable: os.Args[0]}
	for _, arguments := range [][]string{
		nil,
		{},
		{""},
		{"connector\x00source"},
		{strings.Repeat("x", maximumConnectorSupervisorArgumentBytes+1)},
	} {
		if _, err := NewConnectorSupervisorCommand(store, options, arguments); err == nil {
			t.Fatalf("unsafe connector supervisor arguments were accepted: %#v", arguments)
		}
	}
}
