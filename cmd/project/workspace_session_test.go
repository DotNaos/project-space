package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/workspacesession"
	"github.com/spf13/cobra"
)

func TestWorkspaceRuntimeWrapperWaitsForGracefulSessionFlushWhenCodexExitsWithItsContext(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	codex := filepath.Join(directory, "fake-codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\nexec /bin/sleep 60\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(directory, "ready")
	if err := os.WriteFile(ready, []byte("ready\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bootstrap := workspacesession.Bootstrap{
		AppServerSocket: filepath.Join(directory, "codex.sock"), CodexBinary: codex,
		ReadyPath: ready,
	}
	command := &cobra.Command{}
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	ctx, cancel := context.WithCancel(context.Background())
	registered := make(chan struct{})
	var flushed atomic.Bool
	done := make(chan error, 1)
	go func() {
		done <- runWorkspaceRuntimeSessionWithClient(ctx, command, bootstrap,
			func(sessionContext context.Context, _ workspacesession.Bootstrap) error {
				close(registered)
				<-sessionContext.Done()
				time.Sleep(50 * time.Millisecond)
				flushed.Store(true)
				return nil
			})
	}()
	select {
	case <-registered:
	case <-time.After(5 * time.Second):
		t.Fatal("runtime session did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("wrapper stop = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runtime wrapper did not stop")
	}
	if !flushed.Load() {
		t.Fatal("wrapper returned before the outbound session flushed graceful stop")
	}
}
