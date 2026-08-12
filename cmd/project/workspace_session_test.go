//go:build !windows

package main

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/workspacesession"
	"github.com/spf13/cobra"
)

func TestWorkspaceRuntimeWrapperDelegatesLifecycleToTheSessionClient(t *testing.T) {
	bootstrap := workspacesession.Bootstrap{}
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
				return sessionContext.Err()
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
