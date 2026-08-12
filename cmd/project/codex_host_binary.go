package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func resolveCodexHostBinary() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve Project CLI executable: %w", err)
	}
	return resolveAuthenticatedCodexHostBinary(executable, runtime.GOOS)
}

func resolveAuthenticatedCodexHostBinary(projectExecutable string, goos string) (string, error) {
	executable, err := filepath.Abs(projectExecutable)
	if err != nil {
		return "", fmt.Errorf("resolve Project CLI executable: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("resolve Project CLI executable: %w", err)
	}
	name := "project-codex-host"
	if goos == "windows" {
		name += ".exe"
	}
	candidate := filepath.Join(filepath.Dir(executable), name)
	info, err := os.Lstat(candidate)
	if err != nil {
		return "", fmt.Errorf("inspect bundled Codex host binary: %w", err)
	}
	if !usableCodexHostBinary(candidate, info, goos) {
		return "", fmt.Errorf("bundled Codex host binary is not a usable regular file: %s", candidate)
	}
	return candidate, nil
}

func usableCodexHostBinary(path string, info os.FileInfo, goos string) bool {
	if info == nil || info.IsDir() || !info.Mode().IsRegular() {
		return false
	}
	if goos == "windows" {
		return strings.EqualFold(filepath.Ext(path), ".exe")
	}
	return info.Mode()&0o111 != 0
}
