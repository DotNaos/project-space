package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

const (
	defaultConnectorProdHubURL  = "https://projects.os-home.net"
	defaultConnectorDevHubURL   = "http://127.0.0.1:5177"
	defaultConnectorTokenEnv    = "PROJECT_CONNECTOR_REGISTRATION_TOKEN"
	defaultConnectorServiceName = "$(hostname -s)"
)

type connectorOptions struct {
	ConfigPath string
	JSON       bool
}

type connectorSetupOptions struct {
	ConnectorOptions connectorOptions
	ProdURL          string
	DevURL           string
	TokenEnv         string
	NoDev            bool
}

type connectorConnectOptions struct {
	ConnectorOptions     connectorOptions
	RegistrationTokenEnv string
	Disabled             bool
}

type connectorConfig struct {
	Hubs []connectorHubConfig `json:"hubs"`
}

type connectorHubConfig struct {
	Name                 string `json:"name"`
	URL                  string `json:"url"`
	WSURL                string `json:"wsUrl,omitempty"`
	RegistrationTokenEnv string `json:"registrationTokenEnv,omitempty"`
	Disabled             bool   `json:"disabled,omitempty"`
}

func newConnectorCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "connector",
		Short: "Set up Project Space machine connector links",
	}
	cmd.AddCommand(newConnectorSetupCommand())
	cmd.AddCommand(newConnectorInstallCommand())
	cmd.AddCommand(newConnectorConnectCommand())
	cmd.AddCommand(newConnectorStatusCommand())
	return cmd
}

func newConnectorSetupCommand() *cobra.Command {
	options := connectorSetupOptions{
		ProdURL:  defaultConnectorProdHubURL,
		DevURL:   defaultConnectorDevHubURL,
		TokenEnv: defaultConnectorTokenEnv,
	}
	cmd := &cobra.Command{
		Use:   "setup",
		Short: "Configure this machine connector for prod and local Project Space hubs",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			result, err := setupConnector(options)
			if err != nil {
				return err
			}
			printConnectorConfigResult(cmd, result, options.ConnectorOptions.JSON)
			return nil
		},
	}
	addConnectorConfigFlags(cmd, &options.ConnectorOptions)
	cmd.Flags().StringVar(&options.ProdURL, "prod-url", options.ProdURL, "remote Project Space hub URL")
	cmd.Flags().StringVar(&options.DevURL, "dev-url", options.DevURL, "local development Project Space hub URL")
	cmd.Flags().StringVar(&options.TokenEnv, "token-env", options.TokenEnv, "environment variable that contains the connector registration token")
	cmd.Flags().BoolVar(&options.NoDev, "no-dev", false, "only configure the remote Project Space hub")
	return cmd
}

func newConnectorInstallCommand() *cobra.Command {
	options := connectorSetupOptions{
		ProdURL:  defaultConnectorProdHubURL,
		DevURL:   defaultConnectorDevHubURL,
		TokenEnv: defaultConnectorTokenEnv,
	}
	cmd := &cobra.Command{
		Use:   "install",
		Short: "Alias for connector setup until service installers are platform-specific",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			result, err := setupConnector(options)
			if err != nil {
				return err
			}
			printConnectorConfigResult(cmd, result, options.ConnectorOptions.JSON)
			return nil
		},
	}
	addConnectorConfigFlags(cmd, &options.ConnectorOptions)
	cmd.Flags().StringVar(&options.ProdURL, "prod-url", options.ProdURL, "remote Project Space hub URL")
	cmd.Flags().StringVar(&options.DevURL, "dev-url", options.DevURL, "local development Project Space hub URL")
	cmd.Flags().StringVar(&options.TokenEnv, "token-env", options.TokenEnv, "environment variable that contains the connector registration token")
	cmd.Flags().BoolVar(&options.NoDev, "no-dev", false, "only configure the remote Project Space hub")
	return cmd
}

func newConnectorConnectCommand() *cobra.Command {
	options := connectorConnectOptions{
		RegistrationTokenEnv: defaultConnectorTokenEnv,
	}
	cmd := &cobra.Command{
		Use:   "connect <name> <url>",
		Short: "Add or update one Project Space connector hub",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			result, err := connectConnectorHub(args[0], args[1], options)
			if err != nil {
				return err
			}
			printConnectorConfigResult(cmd, result, options.ConnectorOptions.JSON)
			return nil
		},
	}
	addConnectorConfigFlags(cmd, &options.ConnectorOptions)
	cmd.Flags().StringVar(&options.RegistrationTokenEnv, "token-env", options.RegistrationTokenEnv, "environment variable that contains the connector registration token")
	cmd.Flags().BoolVar(&options.Disabled, "disabled", false, "write the hub but keep it disabled")
	return cmd
}

func newConnectorStatusCommand() *cobra.Command {
	options := connectorOptions{}
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show configured Project Space connector hubs",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			path, config, err := readConnectorConfig(options.ConfigPath)
			if err != nil {
				return err
			}
			printConnectorConfigResult(cmd, connectorConfigResult{
				ConfigPath: path,
				Hubs:       config.Hubs,
			}, options.JSON)
			return nil
		},
	}
	addConnectorConfigFlags(cmd, &options)
	return cmd
}

func addConnectorConfigFlags(cmd *cobra.Command, options *connectorOptions) {
	cmd.Flags().StringVar(&options.ConfigPath, "config", "", "connector config file path")
	cmd.Flags().BoolVar(&options.JSON, "json", false, "print machine-readable output")
}

type connectorConfigResult struct {
	ConfigPath string               `json:"configPath"`
	Hubs       []connectorHubConfig `json:"hubs"`
}

func setupConnector(options connectorSetupOptions) (connectorConfigResult, error) {
	path, config, err := readConnectorConfig(options.ConnectorOptions.ConfigPath)
	if err != nil {
		return connectorConfigResult{}, err
	}
	config = upsertConnectorHub(config, connectorHubConfig{
		Name:                 "prod",
		URL:                  options.ProdURL,
		RegistrationTokenEnv: options.TokenEnv,
	})
	if !options.NoDev {
		config = upsertConnectorHub(config, connectorHubConfig{
			Name:                 "dev",
			URL:                  options.DevURL,
			RegistrationTokenEnv: options.TokenEnv,
		})
	}
	if err := writeConnectorConfig(path, config); err != nil {
		return connectorConfigResult{}, err
	}
	return connectorConfigResult{ConfigPath: path, Hubs: config.Hubs}, nil
}

func connectConnectorHub(name string, url string, options connectorConnectOptions) (connectorConfigResult, error) {
	path, config, err := readConnectorConfig(options.ConnectorOptions.ConfigPath)
	if err != nil {
		return connectorConfigResult{}, err
	}
	config = upsertConnectorHub(config, connectorHubConfig{
		Name:                 name,
		URL:                  url,
		RegistrationTokenEnv: options.RegistrationTokenEnv,
		Disabled:             options.Disabled,
	})
	if err := writeConnectorConfig(path, config); err != nil {
		return connectorConfigResult{}, err
	}
	return connectorConfigResult{ConfigPath: path, Hubs: config.Hubs}, nil
}

func readConnectorConfig(path string) (string, connectorConfig, error) {
	resolvedPath, err := connectorConfigPath(path)
	if err != nil {
		return "", connectorConfig{}, err
	}
	body, err := os.ReadFile(resolvedPath)
	if os.IsNotExist(err) {
		return resolvedPath, connectorConfig{}, nil
	}
	if err != nil {
		return "", connectorConfig{}, fmt.Errorf("read connector config: %w", err)
	}
	config := connectorConfig{}
	if err := json.Unmarshal(body, &config); err != nil {
		return "", connectorConfig{}, fmt.Errorf("parse connector config: %w", err)
	}
	return resolvedPath, config, nil
}

func writeConnectorConfig(path string, config connectorConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create connector config directory: %w", err)
	}
	body, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("encode connector config: %w", err)
	}
	body = append(body, '\n')
	if err := os.WriteFile(path, body, 0o600); err != nil {
		return fmt.Errorf("write connector config: %w", err)
	}
	return nil
}

func connectorConfigPath(path string) (string, error) {
	if strings.TrimSpace(path) != "" {
		return filepath.Abs(path)
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory: %w", err)
	}
	return filepath.Join(configDir, "project-space", "connector.json"), nil
}

func upsertConnectorHub(config connectorConfig, hub connectorHubConfig) connectorConfig {
	hub.Name = strings.TrimSpace(hub.Name)
	hub.URL = strings.TrimRight(strings.TrimSpace(hub.URL), "/")
	hub.WSURL = strings.TrimSpace(hub.WSURL)
	hub.RegistrationTokenEnv = strings.TrimSpace(hub.RegistrationTokenEnv)
	for index, existing := range config.Hubs {
		if existing.Name == hub.Name {
			config.Hubs[index] = hub
			return config
		}
	}
	config.Hubs = append(config.Hubs, hub)
	return config
}

func printConnectorConfigResult(cmd *cobra.Command, result connectorConfigResult, asJSON bool) {
	if asJSON {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		_ = encoder.Encode(result)
		return
	}
	cmd.Printf("Connector config: %s\n", result.ConfigPath)
	if len(result.Hubs) == 0 {
		cmd.Println("No connector hubs configured.")
		return
	}
	for _, hub := range result.Hubs {
		status := "enabled"
		if hub.Disabled {
			status = "disabled"
		}
		tokenSource := hub.RegistrationTokenEnv
		if tokenSource == "" {
			tokenSource = defaultConnectorTokenEnv
		}
		cmd.Printf("- %s  %s  %s  token env: %s\n", hub.Name, hub.URL, status, tokenSource)
	}
}
