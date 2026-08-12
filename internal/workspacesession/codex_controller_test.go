package workspacesession

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexControllerRequiresExactReadyHandshakeAndUsesPrivatePipes(t *testing.T) {
	directory := t.TempDir()
	controllerPath := filepath.Join(directory, "project-space-connector")
	script := `#!/bin/sh
printf '%s\n' '{"acceptedCommandSequence":7,"capability":"runtime.codex.v1","lastEventSequence":11,"state":"ready","type":"controller.ready"}'
while IFS= read -r line; do
  case "$line" in
    *controller.stop*) exit 0 ;;
    *controller.command*) printf '%s\n' '{"message":{"type":"runtime.codex.result"},"type":"controller.message"}' ;;
  esac
done
`
	if err := os.WriteFile(controllerPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	bootstrapPath := filepath.Join(directory, "runtime-codex-host-bootstrap.json")
	if err := os.WriteFile(bootstrapPath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	controller, err := startCodexController(ctx, Bootstrap{
		Capabilities:          []string{"runtime.lifecycle", "runtime.heartbeat"},
		RequestedCapabilities: []string{"runtime.codex.v1"},
		CodexControllerBinary: controllerPath, CodexControllerBootstrap: bootstrapPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	if controller.ready.AcceptedCommandSequence != 7 || controller.ready.LastEventSequence != 11 {
		t.Fatalf("controller readiness = %#v", controller.ready)
	}
	if err := controller.commandMessage([]byte(`{"type":"runtime.codex.command"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case output := <-controller.messages:
		if string(output) != `{"message":{"type":"runtime.codex.result"},"type":"controller.message"}` {
			t.Fatalf("controller output = %s", output)
		}
	case <-ctx.Done():
		t.Fatal("controller did not return a typed response")
	}
	controller.observeMessage([]byte(`{"message":{"commandSequence":8,"type":"runtime.codex.command-accepted"},"type":"controller.message"}`))
	controller.observeMessage([]byte(`{"message":{"commandSequence":8,"eventSequence":12,"type":"runtime.codex.event"},"type":"controller.message"}`))
	commandSequence, eventSequence := controller.watermarks()
	if commandSequence != 8 || eventSequence != 12 {
		t.Fatalf("controller watermarks = %d, %d", commandSequence, eventSequence)
	}
	controller.stop()
}

func TestCodexControllerCapabilityCannotStartWithoutControllerFiles(t *testing.T) {
	_, err := startCodexController(context.Background(), Bootstrap{
		Capabilities:             []string{"runtime.lifecycle", "runtime.heartbeat"},
		RequestedCapabilities:    []string{"runtime.codex.v1"},
		CodexControllerBinary:    filepath.Join(t.TempDir(), "missing"),
		CodexControllerBootstrap: filepath.Join(t.TempDir(), "missing.json"),
	})
	if err == nil {
		t.Fatal("missing controller files were accepted")
	}
}
