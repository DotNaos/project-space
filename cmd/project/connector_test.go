package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestConnectorSetupWritesProdAndDevHubs(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "connector.json")
	cmd := newRootCommand()
	stdout := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{
		"connector",
		"setup",
		"--config",
		configPath,
		"--prod-url",
		"https://projects.example.test/",
		"--dev-url",
		"http://127.0.0.1:5999/",
		"--token-env",
		"PROJECT_CONNECTOR_TEST_TOKEN",
		"--json",
	})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("connector setup failed: %v", err)
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
