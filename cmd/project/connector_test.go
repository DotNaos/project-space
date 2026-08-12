package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLegacyConnectorSetupHelperRemainsReadableForMigration(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "connector.json")
	if _, err := setupConnector(connectorSetupOptions{
		ConnectorOptions: connectorOptions{ConfigPath: configPath},
		ProdURL:          "https://projects.example.test/",
		DevURL:           "http://127.0.0.1:5999/",
		TokenEnv:         "PROJECT_CONNECTOR_TEST_TOKEN",
	}); err != nil {
		t.Fatalf("legacy connector config migration helper failed: %v", err)
	}

	body, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	config := connectorConfig{}
	if err := json.Unmarshal(body, &config); err != nil {
		t.Fatalf("parse config: %v", err)
	}
	if len(config.Hubs) != 2 {
		t.Fatalf("expected 2 hubs, got %d", len(config.Hubs))
	}
	if config.Hubs[0].Name != "prod" || config.Hubs[0].URL != "https://projects.example.test" {
		t.Fatalf("unexpected prod hub: %#v", config.Hubs[0])
	}
	if config.Hubs[1].Name != "dev" || config.Hubs[1].URL != "http://127.0.0.1:5999" {
		t.Fatalf("unexpected dev hub: %#v", config.Hubs[1])
	}
	if config.Hubs[0].RegistrationTokenEnv != "PROJECT_CONNECTOR_TEST_TOKEN" {
		t.Fatalf("unexpected token env: %q", config.Hubs[0].RegistrationTokenEnv)
	}
}

func TestConnectorConnectUpdatesExistingHub(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "connector.json")
	if _, err := setupConnector(connectorSetupOptions{
		ConnectorOptions: connectorOptions{ConfigPath: configPath},
		ProdURL:          "https://old.example.test",
		DevURL:           "http://127.0.0.1:5177",
		TokenEnv:         defaultConnectorTokenEnv,
		NoDev:            true,
	}); err != nil {
		t.Fatalf("initial setup failed: %v", err)
	}

	if _, err := connectConnectorHub("prod", "https://new.example.test", connectorConnectOptions{
		ConnectorOptions:     connectorOptions{ConfigPath: configPath},
		RegistrationTokenEnv: "PROJECT_CONNECTOR_TOKEN",
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	_, config, err := readConnectorConfig(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if len(config.Hubs) != 1 {
		t.Fatalf("expected 1 hub, got %d", len(config.Hubs))
	}
	if config.Hubs[0].URL != "https://new.example.test" {
		t.Fatalf("hub was not updated: %#v", config.Hubs[0])
	}
}

func TestConnectorServiceArtifactsKeepTokenOutOfLaunchAgent(t *testing.T) {
	tempDir := t.TempDir()
	sourceBinary := filepath.Join(tempDir, "source-connector")
	if err := os.WriteFile(sourceBinary, []byte("connector-binary"), 0o700); err != nil {
		t.Fatalf("write source connector: %v", err)
	}
	paths := connectorServicePaths{
		Binary:     filepath.Join(tempDir, "bin", "project-space-connector"),
		Runner:     filepath.Join(tempDir, "bin", "project-space-connector-service"),
		Token:      filepath.Join(tempDir, "config", "connector-registration-token"),
		Plist:      filepath.Join(tempDir, "LaunchAgents", connectorLaunchAgentLabel+".plist"),
		StdoutLog:  filepath.Join(tempDir, "logs", "stdout.log"),
		StderrLog:  filepath.Join(tempDir, "logs", "stderr.log"),
		ConfigPath: filepath.Join(tempDir, "config", "connector.json"),
	}
	t.Setenv("PROJECT_CONNECTOR_TEST_TOKEN", "test-secret-value")

	if err := installConnectorArtifacts(sourceBinary, paths, "test-machine", "PROJECT_CONNECTOR_TEST_TOKEN"); err != nil {
		t.Fatalf("install connector artifacts: %v", err)
	}

	for _, path := range []string{paths.Plist, paths.Runner} {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if strings.Contains(string(body), "test-secret-value") {
			t.Fatalf("secret leaked into %s", path)
		}
	}
	tokenBody, err := os.ReadFile(paths.Token)
	if err != nil {
		t.Fatalf("read token file: %v", err)
	}
	if strings.TrimSpace(string(tokenBody)) != "test-secret-value" {
		t.Fatalf("unexpected token file contents")
	}
	tokenInfo, err := os.Stat(paths.Token)
	if err != nil {
		t.Fatalf("stat token file: %v", err)
	}
	if tokenInfo.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode = %o, want 600", tokenInfo.Mode().Perm())
	}
	for path, expectedMode := range map[string]os.FileMode{
		paths.Binary: 0o700,
		paths.Runner: 0o700,
		paths.Plist:  0o600,
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if info.Mode().Perm() != expectedMode {
			t.Fatalf("%s mode = %o, want %o", path, info.Mode().Perm(), expectedMode)
		}
	}

	plistBody, err := os.ReadFile(paths.Plist)
	if err != nil {
		t.Fatalf("read plist: %v", err)
	}
	for _, expected := range []string{paths.ConfigPath, "test-machine", paths.Runner} {
		if !strings.Contains(string(plistBody), expected) {
			t.Fatalf("plist does not contain %q", expected)
		}
	}
}

func TestConnectorRunnerLoadsTokenFileWithoutPuttingItInArguments(t *testing.T) {
	paths := connectorServicePaths{
		Binary: "/Users/test/.local/bin/project-space-connector",
		Token:  "/Users/test/Library/Application Support/project-space/connector-registration-token",
	}
	runner := connectorRunnerScript(paths)

	if !strings.Contains(runner, "IFS= read -r PROJECT_CONNECTOR_REGISTRATION_TOKEN") {
		t.Fatalf("runner does not load the token file")
	}
	if !strings.Contains(runner, "exec '/Users/test/.local/bin/project-space-connector'") {
		t.Fatalf("runner does not exec the connector binary")
	}
}

func TestConnectorLaunchAgentRetriesBootstrapAfterBootout(t *testing.T) {
	originalRun := runConnectorServiceCommand
	originalWait := waitConnectorServiceRetry
	t.Cleanup(func() {
		runConnectorServiceCommand = originalRun
		waitConnectorServiceRetry = originalWait
	})

	bootstrapAttempts := 0
	kickstarted := false
	runConnectorServiceCommand = func(_ string, _ []byte, name string, args ...string) (string, error) {
		if name != "launchctl" {
			t.Fatalf("unexpected command %s", name)
		}
		switch args[0] {
		case "bootout":
			return "", nil
		case "bootstrap":
			bootstrapAttempts++
			if bootstrapAttempts == 1 {
				return "", errors.New("service is still stopping")
			}
			return "", nil
		case "kickstart":
			kickstarted = true
			return "", nil
		default:
			t.Fatalf("unexpected launchctl action %s", args[0])
			return "", nil
		}
	}
	waitConnectorServiceRetry = func(time.Duration) {}

	if err := loadConnectorLaunchAgent("/tmp/connector.plist"); err != nil {
		t.Fatalf("load connector LaunchAgent: %v", err)
	}
	if bootstrapAttempts != 2 {
		t.Fatalf("bootstrap attempts = %d, want 2", bootstrapAttempts)
	}
	if !kickstarted {
		t.Fatalf("connector service was not kickstarted")
	}
}

func TestConnectorServiceWaitsUntilHealthCheckSucceeds(t *testing.T) {
	originalCheck := checkConnectorServiceReady
	originalWait := waitConnectorServiceRetry
	t.Cleanup(func() {
		checkConnectorServiceReady = originalCheck
		waitConnectorServiceRetry = originalWait
	})

	attempts := 0
	checkConnectorServiceReady = func() error {
		attempts++
		if attempts < 3 {
			return errors.New("not ready")
		}
		return nil
	}
	waitConnectorServiceRetry = func(time.Duration) {}

	if err := waitForConnectorService(); err != nil {
		t.Fatalf("wait for connector service: %v", err)
	}
	if attempts != 3 {
		t.Fatalf("health check attempts = %d, want 3", attempts)
	}
}
