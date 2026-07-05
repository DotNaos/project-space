package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestDeployStepsUseExistingComposeFiles(t *testing.T) {
	project := deployProject{
		Environment:    "prod",
		RemoteURL:      "https://github.com/DotNaos/example",
		RemotePath:     "/opt/platform/apps/example",
		Branch:         "main",
		ComposeProject: "example-prod",
	}
	options := deployOptions{
		APIDomain:     "api.example.com",
		ProjectDomain: "example.com",
		Secrets: map[string]deploySecretValue{
			"CLERK_PUBLISHABLE_KEY":                {Value: "clerk-publishable-value", Source: "op://projects/clerk-project/publishable_key"},
			"CLERK_SECRET_KEY":                     {Value: "clerk-secret-value", Source: "op://projects/clerk-project/secret_key"},
			"GITHUB_OAUTH_CLIENT_ID":               {Value: "oauth-client-id", Source: "op://projects/GitHub OAuth App/client_id"},
			"GITHUB_TOKEN":                         {Value: "github-token-value", Source: "op://projects/GitHub Personal Access Token/token"},
			"PROJECT_CONNECTOR_REGISTRATION_TOKEN": {Value: "connector-registration-token-value", Source: "op://projects/Project Space Connector Registration Token/password"},
			"VITE_CLERK_PUBLISHABLE_KEY":           {Value: "clerk-publishable-value", Source: "op://projects/clerk-project/publishable_key"},
		},
	}

	steps := strings.Join(deploySteps(project, options), "\n")
	for _, want := range []string{
		"docker network inspect traefik-public",
		"cat > .env <<'PROJECT_SPACE_ENV'",
		"-p example-prod -f deploy/compose.yml -f deploy/ingress.labels.yml",
		"PROJECT_DOMAIN=example.com",
		"PROJECT_API_DOMAIN=api.example.com",
		"GITHUB_TOKEN=<secret from op://projects/GitHub Personal Access Token/token>",
		"GITHUB_OAUTH_CLIENT_ID=<secret from op://projects/GitHub OAuth App/client_id>",
		"CLERK_PUBLISHABLE_KEY=<secret from op://projects/clerk-project/publishable_key>",
		"VITE_CLERK_PUBLISHABLE_KEY=<secret from op://projects/clerk-project/publishable_key>",
		"CLERK_SECRET_KEY=<secret from op://projects/clerk-project/secret_key>",
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN=<secret from op://projects/Project Space Connector Registration Token/password>",
	} {
		if !strings.Contains(steps, want) {
			t.Fatalf("deploy steps missing %q:\n%s", want, steps)
		}
	}
	if strings.Contains(steps, "github-token-value") ||
		strings.Contains(steps, "oauth-client-id") ||
		strings.Contains(steps, "clerk-publishable-value") ||
		strings.Contains(steps, "clerk-secret-value") ||
		strings.Contains(steps, "connector-registration-token-value") {
		t.Fatalf("deploy dry-run steps leaked secret values:\n%s", steps)
	}
}

func TestDeployComposeScriptUsesSecretValuesOnlyAtRuntime(t *testing.T) {
	project := deployProject{Environment: "prod", RemotePath: "/opt/platform/apps/example", ComposeProject: "example-prod"}
	options := deployOptions{
		APIDomain:     "api.example.com",
		ProjectDomain: "example.com",
		Secrets: map[string]deploySecretValue{
			"CLERK_PUBLISHABLE_KEY":                {Value: "clerk-publishable-value", Source: "op://projects/clerk-project/publishable_key"},
			"CLERK_SECRET_KEY":                     {Value: "clerk-secret-value", Source: "op://projects/clerk-project/secret_key"},
			"GITHUB_OAUTH_CLIENT_ID":               {Value: "oauth-client-id", Source: "op://projects/GitHub OAuth App/client_id"},
			"GITHUB_TOKEN":                         {Value: "github-token-value", Source: "op://projects/GitHub Personal Access Token/token"},
			"PROJECT_CONNECTOR_REGISTRATION_TOKEN": {Value: "connector-registration-token-value", Source: "op://projects/Project Space Connector Registration Token/password"},
		},
	}

	script := deployComposeScript(project, options, true)
	for _, want := range []string{
		"cat > .env <<'PROJECT_SPACE_ENV'",
		"PROJECT_DOMAIN=example.com",
		"PROJECT_API_DOMAIN=api.example.com",
		"GITHUB_TOKEN=github-token-value",
		"GITHUB_OAUTH_CLIENT_ID=oauth-client-id",
		"CLERK_PUBLISHABLE_KEY=clerk-publishable-value",
		"CLERK_SECRET_KEY=clerk-secret-value",
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN=connector-registration-token-value",
		"docker compose --env-file .env -p example-prod -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("runtime deploy script missing %q:\n%s", want, script)
		}
	}
}

func TestGitRemoteURLConvertsGitHubSSH(t *testing.T) {
	converted := normalizeGitHubRemoteURL("git@github.com:DotNaos/example.git")
	if converted != "https://github.com/DotNaos/example" {
		t.Fatalf("converted URL = %q", converted)
	}
}

func TestResolveDeployValueUsesExplicitFlagWithoutPrompt(t *testing.T) {
	cmd := deployValueTestCommand("flag-value", "")
	must(cmd.Flags().Set("host", "flag-value"))

	value, err := resolveDeployValue(cmd, "deploy host", "host", "flag-value", []deployCandidate{
		{Value: "config-value", Source: "deploy/deploy.yaml"},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if value != "flag-value" {
		t.Fatalf("value = %q", value)
	}
}

func TestResolveDeployValueUsesConfigWithoutPrompt(t *testing.T) {
	cmd := deployValueTestCommand("", "\n")

	value, err := resolveDeployValue(cmd, "deploy host", "host", "", []deployCandidate{
		{Value: "deploy@100.84.238.75", Source: "deploy/deploy.yaml"},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if value != "deploy@100.84.238.75" {
		t.Fatalf("value = %q", value)
	}
	if cmd.OutOrStdout().(*bytes.Buffer).String() != "" {
		t.Fatalf("config value prompted unexpectedly:\n%s", cmd.OutOrStdout().(*bytes.Buffer).String())
	}
}

func TestReadDeployConfigRejectsFlatConfig(t *testing.T) {
	root := t.TempDir()
	mustWriteDeployTestFile(t, filepath.Join(root, "deploy", "deploy.yaml"), "host: deploy@example\npath: /opt/app\nbranch: main\ndomain: example.com\napiDomain: api.example.com\n")

	_, err := readDeployConfig(root)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "top-level \"path\" is not supported") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReadDeployConfigRequiresProdAndBeta(t *testing.T) {
	root := t.TempDir()
	mustWriteDeployTestFile(t, filepath.Join(root, "deploy", "deploy.yaml"), "host: deploy@example\nenvironments:\n  prod:\n    default: true\n    branch: main\n    path: /opt/app\n    domain: example.com\n    apiDomain: api.example.com\n")

	_, err := readDeployConfig(root)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "exactly prod and beta") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func deployValueTestCommand(flagValue string, input string) *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().String("host", flagValue, "")
	cmd.SetIn(strings.NewReader(input))
	cmd.SetOut(&bytes.Buffer{})
	return cmd
}

func mustWriteDeployTestFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
