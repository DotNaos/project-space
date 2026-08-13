package projectrun

import (
	"crypto/sha256"
	"encoding/hex"
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

const (
	maximumSetupSteps = 64
	maximumCommands   = 64
	maximumServers    = 64
)

var (
	ErrNotConfigured   = errors.New("project scripts are not configured")
	ErrScriptNotFound  = errors.New("project script is not configured")
	ErrSetupNotFound   = errors.New("project setup step is not configured")
	declarationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)
	environmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// ScriptsConfig v1 remains readable for repositories created before named
// setup steps and servers were introduced. Version 2 separates preparation
// from servers; version 3 also separates finite commands from servers.
type ScriptsConfig struct {
	Version  int               `yaml:"version"`
	Scripts  map[string]Script `yaml:"scripts,omitempty"`
	Setup    []SetupStep       `yaml:"setup,omitempty"`
	Commands map[string]Script `yaml:"commands,omitempty"`
	Servers  map[string]Script `yaml:"servers,omitempty"`
}

type SetupStep struct {
	ID      string   `yaml:"id"`
	Command []string `yaml:"command"`
}

type Script struct {
	Label             string            `yaml:"label,omitempty"`
	Command           []string          `yaml:"command"`
	Environment       map[string]string `yaml:"environment,omitempty"`
	SecretEnvironment map[string]string `yaml:"secretEnvironment,omitempty"`
	HealthCheck       *HealthCheck      `yaml:"healthCheck,omitempty"`
	PrototypeSurface  string            `yaml:"prototypeSurface,omitempty"`
}

type HealthCheck struct {
	Path           string `yaml:"path"`
	TimeoutSeconds int    `yaml:"timeoutSeconds,omitempty"`
}

type Declaration struct {
	Root    string
	Digest  string
	Setup   []SetupStep
	Command map[string]Script
	Server  map[string]Script
}

func LoadDeclaration(directory string) (Declaration, error) {
	root, err := canonicalDirectory(directory)
	if err != nil {
		return Declaration{}, err
	}
	body, err := os.ReadFile(filepath.Join(root, scriptsConfigPath))
	if errors.Is(err, os.ErrNotExist) {
		return Declaration{Root: root}, fmt.Errorf("%w: missing %s", ErrNotConfigured, scriptsConfigPath)
	}
	if err != nil {
		return Declaration{Root: root}, fmt.Errorf("read %s: %w", scriptsConfigPath, err)
	}
	if len(body) > 1<<20 {
		return Declaration{Root: root}, fmt.Errorf("%s exceeds the 1 MiB limit", scriptsConfigPath)
	}
	config := ScriptsConfig{}
	decoder := yaml.NewDecoder(strings.NewReader(string(body)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&config); err != nil {
		return Declaration{Root: root}, fmt.Errorf("parse %s: %w", scriptsConfigPath, err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return Declaration{Root: root}, fmt.Errorf("parse %s: multiple YAML documents are not supported", scriptsConfigPath)
		}
		return Declaration{Root: root}, fmt.Errorf("parse %s: %w", scriptsConfigPath, err)
	}
	if err := validateScriptsConfig(config); err != nil {
		return Declaration{Root: root}, fmt.Errorf("validate %s: %w", scriptsConfigPath, err)
	}
	servers := config.Servers
	if config.Version == 1 {
		servers = config.Scripts
	}
	digest := sha256.Sum256(body)
	commands := config.Commands
	if config.Version == 1 {
		commands = config.Scripts
	}
	return Declaration{
		Root: root, Digest: hex.EncodeToString(digest[:]), Setup: config.Setup,
		Command: commands, Server: servers,
	}, nil
}

func LoadCommand(directory, name string) (string, Script, error) {
	declaration, err := LoadDeclaration(directory)
	if err != nil {
		return declaration.Root, Script{}, err
	}
	command, ok := declaration.Command[name]
	if !ok {
		return declaration.Root, Script{}, fmt.Errorf(
			"%w: command %q is not defined in %s (long-running servers require project serve)",
			ErrScriptNotFound, name, scriptsConfigPath,
		)
	}
	return declaration.Root, command, nil
}

func LoadScript(directory, name string) (string, Script, error) {
	declaration, err := LoadDeclaration(directory)
	if err != nil {
		return declaration.Root, Script{}, err
	}
	script, ok := declaration.Server[name]
	if !ok {
		return declaration.Root, Script{}, fmt.Errorf("%w: %q is not defined in %s", ErrScriptNotFound, name, scriptsConfigPath)
	}
	return declaration.Root, script, nil
}

func (declaration Declaration) SetupNames() []string {
	names := make([]string, 0, len(declaration.Setup))
	for _, step := range declaration.Setup {
		names = append(names, step.ID)
	}
	return names
}

func (declaration Declaration) SetupStep(name string) (SetupStep, error) {
	for _, step := range declaration.Setup {
		if step.ID == name {
			return step, nil
		}
	}
	return SetupStep{}, fmt.Errorf("%w: %q is not defined in %s", ErrSetupNotFound, name, scriptsConfigPath)
}

func validateScriptsConfig(config ScriptsConfig) error {
	switch config.Version {
	case 1:
		if len(config.Scripts) == 0 {
			return fmt.Errorf("scripts must not be empty")
		}
		if len(config.Setup) != 0 || len(config.Servers) != 0 {
			return fmt.Errorf("version 1 supports scripts only")
		}
	case 2:
		if len(config.Scripts) != 0 {
			return fmt.Errorf("version 2 uses servers instead of scripts")
		}
		if len(config.Setup) == 0 {
			return fmt.Errorf("setup must not be empty")
		}
		if len(config.Servers) == 0 {
			return fmt.Errorf("servers must not be empty")
		}
		if len(config.Commands) != 0 {
			return fmt.Errorf("version 2 does not support commands")
		}
	case 3:
		if len(config.Scripts) != 0 {
			return fmt.Errorf("version 3 uses commands and servers instead of scripts")
		}
		if len(config.Setup) == 0 {
			return fmt.Errorf("setup must not be empty")
		}
		if len(config.Commands) == 0 {
			return fmt.Errorf("commands must not be empty")
		}
		if len(config.Servers) == 0 {
			return fmt.Errorf("servers must not be empty")
		}
	default:
		return fmt.Errorf("version must be 1, 2, or 3")
	}
	if len(config.Setup) > maximumSetupSteps {
		return fmt.Errorf("setup must contain at most %d steps", maximumSetupSteps)
	}
	seenSetup := map[string]bool{}
	for _, step := range config.Setup {
		if seenSetup[step.ID] {
			return fmt.Errorf("setup step id %q is duplicated", step.ID)
		}
		seenSetup[step.ID] = true
		if err := validateCommand("setup step", step.ID, step.Command); err != nil {
			return err
		}
	}
	servers := config.Scripts
	if config.Version >= 2 {
		servers = config.Servers
	}
	declarations := map[string]Script{}
	for name, declaration := range servers {
		declarations[name] = declaration
	}
	for name, declaration := range config.Commands {
		if _, exists := declarations[name]; exists {
			return fmt.Errorf("command and server name %q must be distinct", name)
		}
		declarations[name] = declaration
	}
	if len(servers) > maximumServers {
		return fmt.Errorf("servers must contain at most %d entries", maximumServers)
	}
	if len(config.Commands) > maximumCommands {
		return fmt.Errorf("commands must contain at most %d entries", maximumCommands)
	}
	for name, script := range declarations {
		if config.Version == 1 && script.Label != "" {
			return fmt.Errorf("version 1 scripts do not support labels")
		}
		if config.Version == 1 && script.PrototypeSurface != "" {
			return fmt.Errorf("version 1 scripts do not support prototypeSurface")
		}
		if err := validateCommand("server", name, script.Command); err != nil {
			return err
		}
		if err := validateScriptEnvironment(name, script.Environment); err != nil {
			return err
		}
		if err := validateScriptEnvironment(name, script.SecretEnvironment); err != nil {
			return err
		}
		if err := validateScriptSecretEnvironment(name, script.Environment, script.SecretEnvironment); err != nil {
			return err
		}
		if script.HealthCheck != nil {
			if err := validateHealthCheck(*script.HealthCheck); err != nil {
				return fmt.Errorf("server %q healthCheck: %w", name, err)
			}
		}
		if strings.TrimSpace(script.Label) != script.Label || len(script.Label) > 80 || strings.ContainsAny(script.Label, "\r\n\t") {
			return fmt.Errorf("server %q label must be a trimmed single-line value of at most 80 bytes", name)
		}
		if script.PrototypeSurface != "" &&
			script.PrototypeSurface != "mobile-prototype" &&
			script.PrototypeSurface != "desktop-prototype" {
			return fmt.Errorf(
				"server %q prototypeSurface must be mobile-prototype or desktop-prototype",
				name,
			)
		}
	}
	return nil
}

func validateScriptSecretEnvironment(name string, environment, secrets map[string]string) error {
	for key, reference := range secrets {
		if !environmentPattern.MatchString(key) {
			return fmt.Errorf("declaration %q secretEnvironment key %q is invalid", name, key)
		}
		if _, exists := environment[key]; exists {
			return fmt.Errorf("declaration %q environment and secretEnvironment both define %q", name, key)
		}
		if !strings.HasPrefix(reference, "op://") || strings.TrimSpace(reference) != reference ||
			strings.ContainsAny(reference, "\x00\r\n\t") {
			return fmt.Errorf("declaration %q secretEnvironment value %q must be a single 1Password op:// reference", name, key)
		}
	}
	return nil
}

func validateScriptEnvironment(name string, environment map[string]string) error {
	reserved := map[string]bool{
		"PROJECT_HOST": true, "PROJECT_PORT": true, "PROJECT_SPACE_MANAGED_SERVE": true,
		"PROJECT_SPACE_SERVE_MODE": true, "PROJECT_SPACE_APIS": true,
		"PROJECT_SPACE_DATA": true, "PROJECT_SPACE_SIMULATION_STATE": true,
		"PROJECT_SPACE_RUNTIME_ACCESS_URL":       true,
		"PROJECT_ALLOWED_HOSTS":                  true,
		"__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS": true, "PWD": true,
	}
	for key, value := range environment {
		if !environmentPattern.MatchString(key) {
			return fmt.Errorf("declaration %q environment key %q is invalid", name, key)
		}
		if reserved[key] {
			return fmt.Errorf("declaration %q environment key %q is managed by Project CLI", name, key)
		}
		if strings.ContainsRune(value, '\x00') {
			return fmt.Errorf("declaration %q environment value %q contains a null byte", name, key)
		}
	}
	return nil
}

func validateCommand(kind, name string, command []string) error {
	if !declarationPattern.MatchString(name) {
		return fmt.Errorf("%s name %q is invalid", kind, name)
	}
	if len(command) == 0 {
		return fmt.Errorf("%s %q command must not be empty", kind, name)
	}
	for index, argument := range command {
		if strings.TrimSpace(argument) == "" {
			return fmt.Errorf("%s %q command argument %d must not be empty", kind, name, index)
		}
		if strings.ContainsRune(argument, '\x00') {
			return fmt.Errorf("%s %q command argument %d contains a null byte", kind, name, index)
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
