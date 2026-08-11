package projectrun

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
)

func writeRuntimeRequestFile(path string, command Command) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create tmux runtime request directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".request-*.json")
	if err != nil {
		return fmt.Errorf("create tmux runtime request: %w", err)
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect tmux runtime request: %w", err)
	}
	if err := writeRuntimeSupervisorRequest(temporary, command); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync tmux runtime request: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close tmux runtime request: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("publish tmux runtime request: %w", err)
	}
	return nil
}

func SuperviseTmuxRuntime(ctx context.Context, requestPath, logPath string) error {
	body, err := os.ReadFile(requestPath)
	if err != nil {
		return fmt.Errorf("read tmux runtime request: %w", err)
	}
	if err := os.Remove(requestPath); err != nil {
		return fmt.Errorf("remove consumed tmux runtime request: %w", err)
	}
	return SuperviseRuntime(ctx, bytes.NewReader(body), os.Stdout, logPath)
}
