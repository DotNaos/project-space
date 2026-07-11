package worktreeownership

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func worktreeConfigValue(path string, key string) (string, bool, error) {
	gitDirectory, err := git(path, "rev-parse", "--path-format=absolute", "--git-dir")
	if err != nil {
		return "", false, fmt.Errorf("find worktree Git metadata: %w", err)
	}
	configPath := filepath.Join(strings.TrimSpace(gitDirectory), "config.worktree")
	if _, err := os.Stat(configPath); errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	} else if err != nil {
		return "", false, fmt.Errorf("inspect worktree configuration: %w", err)
	}

	command := exec.Command("git", "config", "--file", configPath, "--get", key)
	output, err := command.CombinedOutput()
	value := strings.TrimSpace(string(output))
	if err == nil {
		return value, true, nil
	}
	exitError := &exec.ExitError{}
	if errors.As(err, &exitError) && exitError.ExitCode() == 1 && value == "" {
		return "", false, nil
	}
	if value == "" {
		value = err.Error()
	}
	return "", false, fmt.Errorf("read worktree configuration %s: %s", key, value)
}

func readWorktreeConfig(path string, key string) string {
	value, _, _ := worktreeConfigValue(path, key)
	return value
}
