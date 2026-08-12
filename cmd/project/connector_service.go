package main

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const connectorLaunchAgentLabel = "net.os-home.project-space-connector"

var (
	runConnectorServiceCommand = runCommand
	waitConnectorServiceRetry  = time.Sleep
	checkConnectorServiceReady = connectorServiceHealthCheck
)

type connectorInstallResult struct {
	ConfigPath  string               `json:"configPath"`
	Hubs        []connectorHubConfig `json:"hubs"`
	BinaryPath  string               `json:"binaryPath"`
	ServicePath string               `json:"servicePath"`
	ServiceName string               `json:"serviceName"`
	Status      string               `json:"status"`
}

type connectorServicePaths struct {
	Binary     string
	Runner     string
	Token      string
	Plist      string
	StdoutLog  string
	StderrLog  string
	ConfigPath string
}

func installConnectorService(options connectorInstallOptions) (connectorInstallResult, error) {
	if runtime.GOOS != "darwin" {
		return connectorInstallResult{}, fmt.Errorf("connector service installation is currently supported on macOS")
	}

	configResult, err := setupConnector(options.SetupOptions)
	if err != nil {
		return connectorInstallResult{}, err
	}
	paths, err := resolveConnectorServicePaths(configResult.ConfigPath, options)
	if err != nil {
		return connectorInstallResult{}, err
	}
	sourceBinary, err := resolveConnectorInstallerBinary(options.BinaryPath)
	if err != nil {
		return connectorInstallResult{}, err
	}
	serviceName, err := resolveConnectorServiceName(options.ServiceName)
	if err != nil {
		return connectorInstallResult{}, err
	}

	if err := installConnectorArtifacts(sourceBinary, paths, serviceName, options.SetupOptions.TokenEnv); err != nil {
		return connectorInstallResult{}, err
	}
	if err := loadConnectorLaunchAgent(paths.Plist); err != nil {
		return connectorInstallResult{}, err
	}
	if err := waitForConnectorService(); err != nil {
		return connectorInstallResult{}, err
	}

	return connectorInstallResult{
		ConfigPath:  configResult.ConfigPath,
		Hubs:        configResult.Hubs,
		BinaryPath:  paths.Binary,
		ServicePath: paths.Plist,
		ServiceName: serviceName,
		Status:      "running",
	}, nil
}

func resolveConnectorServicePaths(configPath string, options connectorInstallOptions) (connectorServicePaths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return connectorServicePaths{}, fmt.Errorf("resolve home directory: %w", err)
	}
	installDir := strings.TrimSpace(options.InstallDir)
	if installDir == "" {
		installDir = filepath.Join(home, ".local", "bin")
	}
	installDir, err = filepath.Abs(installDir)
	if err != nil {
		return connectorServicePaths{}, fmt.Errorf("resolve connector install directory: %w", err)
	}
	tokenFile := strings.TrimSpace(options.TokenFile)
	if tokenFile == "" {
		tokenFile = filepath.Join(filepath.Dir(configPath), "connector-registration-token")
	}
	tokenFile, err = filepath.Abs(tokenFile)
	if err != nil {
		return connectorServicePaths{}, fmt.Errorf("resolve connector token file: %w", err)
	}
	logDir := filepath.Join(home, "Library", "Logs", "Project Space")

	return connectorServicePaths{
		Binary:     filepath.Join(installDir, "project-space-connector"),
		Runner:     filepath.Join(installDir, "project-space-connector-service"),
		Token:      tokenFile,
		Plist:      filepath.Join(home, "Library", "LaunchAgents", connectorLaunchAgentLabel+".plist"),
		StdoutLog:  filepath.Join(logDir, "connector.stdout.log"),
		StderrLog:  filepath.Join(logDir, "connector.stderr.log"),
		ConfigPath: configPath,
	}, nil
}

// resolveConnectorBinary is the authenticated runtime boundary used by
// `project connector run`. The authenticated connector must be the bundled
// sibling of the running CLI.
func resolveConnectorBinary() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve Project CLI executable: %w", err)
	}
	return resolveAuthenticatedConnectorBinary(executable, runtime.GOOS)
}

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
	if !usableConnectorBinary(candidate, info, goos) {
		return "", fmt.Errorf("bundled Codex host binary is not a usable regular file: %s", candidate)
	}
	return candidate, nil
}

func resolveAuthenticatedConnectorBinary(projectExecutable string, goos string) (string, error) {
	projectExecutable, err := filepath.Abs(projectExecutable)
	if err != nil {
		return "", fmt.Errorf("resolve Project CLI executable: %w", err)
	}
	projectExecutable, err = filepath.EvalSymlinks(projectExecutable)
	if err != nil {
		return "", fmt.Errorf("resolve Project CLI executable: %w", err)
	}
	candidate := filepath.Join(filepath.Dir(projectExecutable), connectorBinaryName(goos))
	info, err := os.Lstat(candidate)
	if err != nil {
		return "", fmt.Errorf("inspect bundled connector binary: %w", err)
	}
	if !usableConnectorBinary(candidate, info, goos) {
		return "", fmt.Errorf("bundled connector binary is not a usable regular file: %s", candidate)
	}
	return candidate, nil
}

// resolveConnectorInstallerBinary preserves the explicit development lookup
// used by the legacy macOS connector installer. It is never used by the
// authenticated machine connector runtime.
func resolveConnectorInstallerBinary(explicitPath string) (string, error) {
	binaryName := connectorBinaryName(runtime.GOOS)
	candidates := []string{}
	if strings.TrimSpace(explicitPath) != "" {
		candidates = append(candidates, explicitPath)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "dist", binaryName))
	}
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(executable), binaryName))
	}
	if found, err := exec.LookPath(binaryName); err == nil {
		candidates = append(candidates, found)
	}

	for _, candidate := range candidates {
		resolved, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(resolved)
		if err == nil && usableConnectorBinary(resolved, info, runtime.GOOS) {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("connector binary not found; build it or pass --binary")
}

func connectorBinaryName(goos string) string {
	if goos == "windows" {
		return "project-space-connector.exe"
	}
	return "project-space-connector"
}

func usableConnectorBinary(path string, info os.FileInfo, goos string) bool {
	if info == nil || info.IsDir() || !info.Mode().IsRegular() {
		return false
	}
	if goos == "windows" {
		return strings.EqualFold(filepath.Ext(path), ".exe")
	}
	return info.Mode()&0o111 != 0
}

func resolveConnectorServiceName(explicitName string) (string, error) {
	if name := strings.TrimSpace(explicitName); name != "" {
		return name, nil
	}
	hostname, err := os.Hostname()
	if err != nil {
		return "", fmt.Errorf("resolve connector service name: %w", err)
	}
	return strings.Split(hostname, ".")[0], nil
}

func installConnectorArtifacts(sourceBinary string, paths connectorServicePaths, serviceName string, tokenEnv string) error {
	for _, directory := range []string{
		filepath.Dir(paths.Binary),
		filepath.Dir(paths.Token),
		filepath.Dir(paths.Plist),
		filepath.Dir(paths.StdoutLog),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return fmt.Errorf("create connector service directory: %w", err)
		}
	}
	if err := copyExecutable(sourceBinary, paths.Binary); err != nil {
		return err
	}
	if err := os.Chmod(paths.Binary, 0o700); err != nil {
		return fmt.Errorf("secure installed connector binary: %w", err)
	}
	if err := persistConnectorToken(paths.Token, tokenEnv); err != nil {
		return err
	}
	if err := os.WriteFile(paths.Runner, []byte(connectorRunnerScript(paths)), 0o700); err != nil {
		return fmt.Errorf("write connector service runner: %w", err)
	}
	if err := os.Chmod(paths.Runner, 0o700); err != nil {
		return fmt.Errorf("secure connector service runner: %w", err)
	}
	if err := os.WriteFile(paths.Plist, []byte(connectorLaunchAgentPlist(paths, serviceName)), 0o600); err != nil {
		return fmt.Errorf("write connector LaunchAgent: %w", err)
	}
	if err := os.Chmod(paths.Plist, 0o600); err != nil {
		return fmt.Errorf("secure connector LaunchAgent: %w", err)
	}
	return nil
}

func copyExecutable(source string, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open connector binary: %w", err)
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return fmt.Errorf("create installed connector binary: %w", err)
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return fmt.Errorf("copy connector binary: %w", err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close installed connector binary: %w", err)
	}
	return nil
}

func persistConnectorToken(path string, tokenEnv string) error {
	tokenEnv = strings.TrimSpace(tokenEnv)
	if tokenEnv == "" {
		tokenEnv = defaultConnectorTokenEnv
	}
	token := strings.TrimSpace(os.Getenv(tokenEnv))
	if token == "" {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return os.Chmod(path, 0o600)
		}
		return fmt.Errorf("%s is not set and no existing connector token file is available", tokenEnv)
	}
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return fmt.Errorf("write connector token file: %w", err)
	}
	return os.Chmod(path, 0o600)
}

func connectorRunnerScript(paths connectorServicePaths) string {
	return fmt.Sprintf(`#!/bin/sh
set -eu
IFS= read -r PROJECT_CONNECTOR_REGISTRATION_TOKEN < %s
export PROJECT_CONNECTOR_REGISTRATION_TOKEN
exec %s
`, connectorShellQuote(paths.Token), connectorShellQuote(paths.Binary))
}

func connectorLaunchAgentPlist(paths connectorServicePaths, serviceName string) string {
	escape := html.EscapeString
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROJECT_CONNECTOR_CONFIG</key>
    <string>%s</string>
    <key>PROJECT_CONNECTOR_SERVICE_NAME</key>
    <string>%s</string>
    <key>PROJECT_SPACE_HOST</key>
    <string>127.0.0.1</string>
    <key>PROJECT_SPACE_PORT</key>
    <string>4173</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`, connectorLaunchAgentLabel, escape(paths.Runner), escape(paths.ConfigPath), escape(serviceName), escape(paths.StdoutLog), escape(paths.StderrLog))
}

func loadConnectorLaunchAgent(plistPath string) error {
	domain := "gui/" + strconv.Itoa(os.Getuid())
	service := domain + "/" + connectorLaunchAgentLabel
	_, _ = runConnectorServiceCommand("", nil, "launchctl", "bootout", service)

	var bootstrapErr error
	for attempt := 0; attempt < 8; attempt++ {
		if _, err := runConnectorServiceCommand("", nil, "launchctl", "bootstrap", domain, plistPath); err == nil {
			bootstrapErr = nil
			break
		} else {
			bootstrapErr = err
			waitConnectorServiceRetry(150 * time.Millisecond)
		}
	}
	if bootstrapErr != nil {
		return fmt.Errorf("load connector LaunchAgent: %w", bootstrapErr)
	}
	if _, err := runConnectorServiceCommand("", nil, "launchctl", "kickstart", "-k", service); err != nil {
		return fmt.Errorf("start connector LaunchAgent: %w", err)
	}
	return nil
}

func waitForConnectorService() error {
	var lastErr error
	for attempt := 0; attempt < 30; attempt++ {
		if err := checkConnectorServiceReady(); err == nil {
			return nil
		} else {
			lastErr = err
			waitConnectorServiceRetry(200 * time.Millisecond)
		}
	}
	return fmt.Errorf("connector service did not become ready: %w", lastErr)
}

func connectorServiceHealthCheck() error {
	client := http.Client{Timeout: 500 * time.Millisecond}
	response, err := client.Get("http://127.0.0.1:4173/api/health")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("health endpoint returned %s", response.Status)
	}
	return nil
}

func connectorShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func printConnectorInstallResult(cmd *cobra.Command, result connectorInstallResult, asJSON bool) {
	if asJSON {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		_ = encoder.Encode(result)
		return
	}
	printConnectorConfigResult(cmd, connectorConfigResult{
		ConfigPath: result.ConfigPath,
		Hubs:       result.Hubs,
	}, false)
	cmd.Printf("Service: %s (%s)\n", result.ServiceName, result.Status)
	cmd.Printf("LaunchAgent: %s\n", result.ServicePath)
}
