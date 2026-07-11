package projectrun

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const scriptsConfigPath = ".project/scripts.yaml"

var (
	ErrNotConfigured  = errors.New("project scripts are not configured")
	ErrScriptNotFound = errors.New("project script is not configured")
	scriptNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
)

type ScriptsConfig struct {
	Version int               `yaml:"version"`
	Scripts map[string]Script `yaml:"scripts"`
}

type Script struct {
	Command     []string     `yaml:"command"`
	HealthCheck *HealthCheck `yaml:"healthCheck,omitempty"`
}

type HealthCheck struct {
	Path           string `yaml:"path"`
	TimeoutSeconds int    `yaml:"timeoutSeconds,omitempty"`
}

func LoadScript(directory, name string) (string, Script, error) {
	root, err := canonicalDirectory(directory)
	if err != nil {
		return "", Script{}, err
	}
	body, err := os.Open(filepath.Join(root, scriptsConfigPath))
	if errors.Is(err, os.ErrNotExist) {
		return root, Script{}, fmt.Errorf("%w: missing %s", ErrNotConfigured, scriptsConfigPath)
	}
	if err != nil {
		return root, Script{}, fmt.Errorf("read %s: %w", scriptsConfigPath, err)
	}
	defer body.Close()
	info, err := body.Stat()
	if err != nil {
		return root, Script{}, fmt.Errorf("inspect %s: %w", scriptsConfigPath, err)
	}
	if info.Size() > 1<<20 {
		return root, Script{}, fmt.Errorf("%s exceeds the 1 MiB limit", scriptsConfigPath)
	}

	config := ScriptsConfig{}
	decoder := yaml.NewDecoder(body)
	decoder.KnownFields(true)
	if err := decoder.Decode(&config); err != nil {
		return root, Script{}, fmt.Errorf("parse %s: %w", scriptsConfigPath, err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return root, Script{}, fmt.Errorf("parse %s: multiple YAML documents are not supported", scriptsConfigPath)
		}
		return root, Script{}, fmt.Errorf("parse %s: %w", scriptsConfigPath, err)
	}
	if err := validateScriptsConfig(config); err != nil {
		return root, Script{}, fmt.Errorf("validate %s: %w", scriptsConfigPath, err)
	}
	script, ok := config.Scripts[name]
	if !ok {
		return root, Script{}, fmt.Errorf("%w: %q is not defined in %s", ErrScriptNotFound, name, scriptsConfigPath)
	}
	return root, script, nil
}

func validateScriptsConfig(config ScriptsConfig) error {
	if config.Version != 1 {
		return fmt.Errorf("version must be 1")
	}
	if len(config.Scripts) == 0 {
		return fmt.Errorf("scripts must not be empty")
	}
	for name, script := range config.Scripts {
		if !scriptNamePattern.MatchString(name) {
			return fmt.Errorf("script name %q is invalid", name)
		}
		if len(script.Command) == 0 {
			return fmt.Errorf("script %q command must not be empty", name)
		}
		for index, argument := range script.Command {
			if strings.TrimSpace(argument) == "" {
				return fmt.Errorf("script %q command argument %d must not be empty", name, index)
			}
			if strings.ContainsRune(argument, '\x00') {
				return fmt.Errorf("script %q command argument %d contains a null byte", name, index)
			}
		}
		if script.HealthCheck != nil {
			if err := validateHealthCheck(*script.HealthCheck); err != nil {
				return fmt.Errorf("script %q healthCheck: %w", name, err)
			}
		}
	}
	return nil
}

func validateHealthCheck(check HealthCheck) error {
	if check.Path == "" || !strings.HasPrefix(check.Path, "/") || strings.HasPrefix(check.Path, "//") {
		return fmt.Errorf("path must start with one slash")
	}
	if strings.ContainsAny(check.Path, "\r\n\t ") {
		return fmt.Errorf("path must not contain whitespace")
	}
	if check.TimeoutSeconds < 0 || check.TimeoutSeconds > 300 {
		return fmt.Errorf("timeoutSeconds must be between 1 and 300")
	}
	return nil
}

func (script Script) Timeout() time.Duration {
	if script.HealthCheck == nil || script.HealthCheck.TimeoutSeconds == 0 {
		return 45 * time.Second
	}
	return time.Duration(script.HealthCheck.TimeoutSeconds) * time.Second
}

func (script Script) HealthPath() string {
	if script.HealthCheck == nil {
		return ""
	}
	return script.HealthCheck.Path
}

func canonicalDirectory(directory string) (string, error) {
	root, err := filepath.Abs(directory)
	if err != nil {
		return "", fmt.Errorf("resolve project directory: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return "", fmt.Errorf("read project directory %q: %w", root, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("project directory %q is not a directory", root)
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve project directory symlinks: %w", err)
	}
	return filepath.Clean(resolved), nil
}
