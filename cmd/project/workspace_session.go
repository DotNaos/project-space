package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/DotNaos/project-space/internal/workspacesession"
	"github.com/spf13/cobra"
)

func newWorkspaceRuntimeSessionCommand() *cobra.Command {
	bootstrapPath := ""
	command := &cobra.Command{
		Use: "__workspace-runtime-session", Hidden: true, Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			info, err := os.Lstat(bootstrapPath)
			if err != nil || !filepath.IsAbs(bootstrapPath) || filepath.Clean(bootstrapPath) != bootstrapPath ||
				!info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 16*1024 {
				return fmt.Errorf("Workspace Runtime bootstrap is not protected")
			}
			file, err := os.Open(bootstrapPath)
			if err != nil {
				return fmt.Errorf("read Workspace Runtime bootstrap")
			}
			defer file.Close()
			opened, err := file.Stat()
			if err != nil || !os.SameFile(info, opened) {
				return fmt.Errorf("Workspace Runtime bootstrap changed while opening")
			}
			var bootstrap workspacesession.Bootstrap
			decoder := json.NewDecoder(io.LimitReader(file, 16*1024+1))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&bootstrap); err != nil {
				return fmt.Errorf("decode Workspace Runtime bootstrap")
			}
			var extra any
			if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
				return fmt.Errorf("decode Workspace Runtime bootstrap")
			}
			if err := workspacesession.ValidateBootstrap(bootstrap, time.Now()); err != nil ||
				bootstrap.CodexBinary == "" || bootstrap.AppServerSocket == "" || bootstrap.ReadyPath == "" {
				return fmt.Errorf("Workspace Runtime launch bootstrap is invalid")
			}
			return runWorkspaceRuntimeSession(command.Context(), command, bootstrap)
		},
	}
	command.Flags().StringVar(&bootstrapPath, "bootstrap", "", "protected Runtime Session bootstrap path")
	_ = command.MarkFlagRequired("bootstrap")
	return command
}

func runWorkspaceRuntimeSession(
	ctx context.Context,
	command *cobra.Command,
	bootstrap workspacesession.Bootstrap,
) error {
	return runWorkspaceRuntimeSessionWithClient(ctx, command, bootstrap, (workspacesession.Client{}).Run)
}

func runWorkspaceRuntimeSessionWithClient(
	ctx context.Context,
	command *cobra.Command,
	bootstrap workspacesession.Bootstrap,
	runSession func(context.Context, workspacesession.Bootstrap) error,
) error {
	codex := exec.CommandContext(
		ctx,
		bootstrap.CodexBinary,
		"app-server",
		"--listen",
		"unix://"+bootstrap.AppServerSocket,
		"--strict-config",
	)
	codex.Stdin = nil
	codex.Stdout = command.OutOrStdout()
	codex.Stderr = command.ErrOrStderr()
	codex.Env = os.Environ()
	if err := codex.Start(); err != nil {
		return fmt.Errorf("start pinned Codex app-server: %w", err)
	}
	codexDone := make(chan error, 1)
	go func() { codexDone <- codex.Wait() }()
	if err := waitForRuntimeReady(ctx, bootstrap.ReadyPath, codexDone); err != nil {
		return err
	}
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	defer cancelSession()
	sessionDone := make(chan error, 1)
	go func() { sessionDone <- runSession(sessionCtx, bootstrap) }()
	select {
	case err := <-codexDone:
		if runtimeStopRequested(ctx) {
			waitForRuntimeSessionShutdown(cancelSession, sessionDone)
			return ctx.Err()
		}
		if err == nil {
			return fmt.Errorf("pinned Codex app-server exited")
		}
		return fmt.Errorf("pinned Codex app-server exited: %w", err)
	case sessionErr := <-sessionDone:
		// Session expiry or loss makes telemetry unavailable, but must not stop
		// the generation-owned Codex runtime. SSH remains the recovery path.
		select {
		case codexErr := <-codexDone:
			return errors.Join(sessionErr, codexErr)
		case <-ctx.Done():
			return ctx.Err()
		}
	case <-ctx.Done():
		waitForRuntimeSessionShutdown(cancelSession, sessionDone)
		return ctx.Err()
	}
}

func runtimeStopRequested(ctx context.Context) bool {
	if ctx.Err() != nil {
		return true
	}
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return true
	case <-timer.C:
		return false
	}
}

func waitForRuntimeSessionShutdown(cancel context.CancelFunc, sessionDone <-chan error) {
	cancel()
	timer := time.NewTimer(2500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-sessionDone:
	case <-timer.C:
	}
}

func waitForRuntimeReady(ctx context.Context, path string, codexDone <-chan error) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		encoded, err := os.ReadFile(path)
		if err == nil {
			info, statErr := os.Lstat(path)
			if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 ||
				string(encoded) != "ready\n" {
				return fmt.Errorf("Workspace Runtime readiness marker is invalid")
			}
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("read Workspace Runtime readiness marker")
		}
		select {
		case err := <-codexDone:
			return fmt.Errorf("pinned Codex app-server exited before readiness: %w", err)
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
