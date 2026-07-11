package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

const (
	deployProdEnvironment = "prod"
	deployBetaEnvironment = "beta"
)

type deployConfig struct {
	Host         string                             `yaml:"host" json:"host"`
	Secrets      map[string]string                  `yaml:"secrets,omitempty" json:"secrets,omitempty"`
	Environments map[string]deployEnvironmentConfig `yaml:"environments" json:"environments"`
}

type deployEnvironmentConfig struct {
	Default   bool              `yaml:"default,omitempty" json:"default"`
	Path      string            `yaml:"path" json:"path"`
	Branch    string            `yaml:"branch" json:"branch"`
	Domain    string            `yaml:"domain" json:"domain"`
	APIDomain string            `yaml:"apiDomain" json:"apiDomain"`
	Email     string            `yaml:"email,omitempty" json:"email,omitempty"`
	Secrets   map[string]string `yaml:"secrets,omitempty" json:"secrets,omitempty"`
}

type deployCandidate struct {
	Value  string
	Source string
}

type deploySecretValue struct {
	Value  string `json:"-"`
	Source string `json:"source"`
}

type deployStatusReport struct {
	ProjectRoot  string          `json:"projectRoot"`
	ProjectName  string          `json:"projectName"`
	Host         string          `json:"host"`
	Environments []deployProject `json:"environments"`
}

func readDeployConfig(projectRoot string) (deployConfig, error) {
	path := filepath.Join(projectRoot, "deploy", "deploy.yaml")
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return deployConfig{}, fmt.Errorf("deploy/deploy.yaml is required")
	}
	if err != nil {
		return deployConfig{}, fmt.Errorf("read deploy/deploy.yaml: %w", err)
	}
	var raw map[string]any
	if err := yaml.Unmarshal(body, &raw); err != nil {
		return deployConfig{}, fmt.Errorf("parse deploy/deploy.yaml: %w", err)
	}
	for _, legacy := range []string{"path", "branch", "domain", "apiDomain", "email"} {
		if _, ok := raw[legacy]; ok {
			return deployConfig{}, fmt.Errorf("deploy/deploy.yaml must use environments.prod and environments.beta; top-level %q is not supported", legacy)
		}
	}
	config := deployConfig{}
	if err := yaml.Unmarshal(body, &config); err != nil {
		return deployConfig{}, fmt.Errorf("parse deploy/deploy.yaml: %w", err)
	}
	if err := validateDeployConfig(config); err != nil {
		return deployConfig{}, err
	}
	return config, nil
}

func validateDeployConfig(config deployConfig) error {
	if strings.TrimSpace(config.Host) == "" {
		return fmt.Errorf("deploy/deploy.yaml host is required")
	}
	if len(config.Environments) != 2 {
		return fmt.Errorf("deploy/deploy.yaml must define exactly prod and beta environments")
	}
	for name := range config.Environments {
		if name != deployProdEnvironment && name != deployBetaEnvironment {
			return fmt.Errorf("unsupported deployment environment %q; only prod and beta are supported", name)
		}
	}
	for _, name := range []string{deployProdEnvironment, deployBetaEnvironment} {
		env, ok := config.Environments[name]
		if !ok {
			return fmt.Errorf("deploy/deploy.yaml missing environments.%s", name)
		}
		if err := validateDeployEnvironmentConfig(name, env); err != nil {
			return err
		}
	}
	if !config.Environments[deployProdEnvironment].Default {
		return fmt.Errorf("deploy/deploy.yaml environments.prod.default must be true")
	}
	if config.Environments[deployBetaEnvironment].Default {
		return fmt.Errorf("deploy/deploy.yaml environments.beta.default must not be true")
	}
	return nil
}

func validateDeployEnvironmentConfig(name string, env deployEnvironmentConfig) error {
	if strings.TrimSpace(env.Branch) == "" {
		return fmt.Errorf("deploy/deploy.yaml environments.%s.branch is required", name)
	}
	if strings.TrimSpace(env.Path) == "" {
		return fmt.Errorf("deploy/deploy.yaml environments.%s.path is required", name)
	}
	if strings.TrimSpace(env.Domain) == "" {
		return fmt.Errorf("deploy/deploy.yaml environments.%s.domain is required", name)
	}
	if strings.TrimSpace(env.APIDomain) == "" {
		return fmt.Errorf("deploy/deploy.yaml environments.%s.apiDomain is required", name)
	}
	if name == deployProdEnvironment && env.Branch != "main" {
		return fmt.Errorf("deploy/deploy.yaml environments.prod.branch must be main")
	}
	if name == deployBetaEnvironment && env.Branch != "beta" {
		return fmt.Errorf("deploy/deploy.yaml environments.beta.branch must be beta")
	}
	return nil
}

func deployEnvironmentNames(config deployConfig) []string {
	names := make([]string, 0, len(config.Environments))
	for name := range config.Environments {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func resolveDeployValue(cmd *cobra.Command, label string, flagName string, flagValue string, candidates []deployCandidate, required bool) (string, error) {
	if cmd.Flags().Changed(flagName) {
		if required && flagValue == "" {
			return "", fmt.Errorf("%s is required; pass --%s", label, flagName)
		}
		return flagValue, nil
	}
	for _, candidate := range candidates {
		value := strings.TrimSpace(candidate.Value)
		if value != "" {
			return value, nil
		}
	}
	if required {
		return "", fmt.Errorf("%s is required in deploy/deploy.yaml or --%s", label, flagName)
	}
	return "", nil
}

func configCandidate(value string, source string) deployCandidate {
	return deployCandidate{Value: value, Source: source}
}

func mergedDeploySecrets(global map[string]string, env map[string]string) map[string]string {
	merged := map[string]string{}
	for name, source := range global {
		merged[name] = source
	}
	for name, source := range env {
		merged[name] = source
	}
	return merged
}

func resolveDeploySecrets(sources map[string]string) (map[string]deploySecretValue, error) {
	secrets := map[string]deploySecretValue{}
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		source := strings.TrimSpace(sources[name])
		if source == "" {
			continue
		}
		value := strings.TrimSpace(os.Getenv(name))
		if value != "" {
			if strings.ContainsAny(value, "\r\n\x00") {
				return nil, fmt.Errorf("secret %s contains unsupported control characters", name)
			}
			secrets[name] = deploySecretValue{Value: value, Source: "$" + name}
			continue
		}
		if !strings.HasPrefix(source, "op://") {
			return nil, fmt.Errorf("secret %s must use an op:// reference or an environment variable override", name)
		}
		output, err := runCommand("", nil, "op", "read", source)
		if err != nil {
			return nil, fmt.Errorf("read secret %s from 1Password: %w", name, err)
		}
		value = strings.TrimRight(output, "\r\n")
		if value == "" {
			return nil, fmt.Errorf("secret %s from 1Password was empty", name)
		}
		if strings.ContainsAny(value, "\r\n\x00") {
			return nil, fmt.Errorf("secret %s contains unsupported control characters", name)
		}
		secrets[name] = deploySecretValue{Value: value, Source: source}
	}
	return secrets, nil
}

func deploySecretSources(sources map[string]string) map[string]deploySecretValue {
	secrets := map[string]deploySecretValue{}
	for name, source := range sources {
		if strings.TrimSpace(source) == "" {
			continue
		}
		secrets[name] = deploySecretValue{Source: source}
	}
	return secrets
}

func composeProjectName(projectName string, environment string) string {
	return projectName + "-" + environment
}
