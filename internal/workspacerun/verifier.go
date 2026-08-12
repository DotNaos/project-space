package workspacerun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type ExactToolVerifier struct{}

func (ExactToolVerifier) Verify(ctx context.Context, manifest Manifest) (VerifiedTools, error) {
	pins := append([]ToolPin{manifest.ProjectRuntime, manifest.Codex}, manifest.Toolchains...)
	resolved := map[ToolID]string{}
	for _, pin := range pins {
		path, err := verifyTool(ctx, pin)
		if err != nil {
			return VerifiedTools{}, err
		}
		resolved[pin.ID] = path
	}
	return VerifiedTools{ProjectBinary: resolved[ToolProject], CodexBinary: resolved[ToolCodex]}, nil
}

func verifyTool(ctx context.Context, pin ToolPin) (string, error) {
	if err := validateToolPin("tool", pin); err != nil {
		return "", err
	}
	executable, arguments := toolProbe(pin.ID)
	path, err := exec.LookPath(executable)
	if err != nil {
		return "", fmt.Errorf("resolve pinned tool %q: %w", pin.ID, err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("resolve pinned tool %q: %w", pin.ID, err)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("pinned tool %q is not a regular executable", pin.ID)
	}
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open pinned tool %q: %w", pin.ID, err)
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return "", fmt.Errorf("hash pinned tool %q: %w", pin.ID, errorsJoin(copyErr, closeErr))
	}
	if digest := hex.EncodeToString(hash.Sum(nil)); digest != pin.SHA256 {
		return "", fmt.Errorf("pinned tool %q checksum mismatch", pin.ID)
	}
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(probeCtx, path, arguments...)
	command.Env = filteredEnvironment(os.Environ())
	body, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("verify pinned tool %q version: %w", pin.ID, err)
	}
	observed := strings.TrimSpace(string(body))
	if len(observed) > 4096 || !versionTokenPresent(observed, pin.Version) {
		return "", fmt.Errorf("pinned tool %q version mismatch", pin.ID)
	}
	return path, nil
}

func versionTokenPresent(output, version string) bool {
	for _, token := range strings.FieldsFunc(output, func(character rune) bool {
		return !((character >= '0' && character <= '9') || (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || strings.ContainsRune(".-+", character))
	}) {
		if token == version || token == "v"+version || token == "go"+version {
			return true
		}
	}
	return false
}

func toolProbe(id ToolID) (string, []string) {
	switch id {
	case ToolGo:
		return "go", []string{"version"}
	case ToolPython:
		return "python3", []string{"--version"}
	case ToolRust:
		return "rustc", []string{"--version"}
	default:
		return string(id), []string{"--version"}
	}
}

func errorsJoin(values ...error) error {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
