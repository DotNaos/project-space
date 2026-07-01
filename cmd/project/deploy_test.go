package main

import (
	"bufio"
	"bytes"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestDeployStepsUseExistingComposeFiles(t *testing.T) {
	project := deployProject{
		RemoteURL:  "https://github.com/DotNaos/example",
		RemotePath: "/opt/platform/apps/example",
		Branch:     "main",
	}
	options := deployOptions{
		APIDomain:                        "example-api.com",
		ClerkPublishableKey:              "clerk-publishable-value",
		ClerkPublishableKeySource:        deployClerkPublishableKeyRef,
		ClerkSecretKey:                   "clerk-secret-value",
		ClerkSecretKeySource:             deployClerkSecretKeyRef,
		ConnectorRegistrationToken:       "connector-registration-token-value",
		ConnectorRegistrationTokenSource: deployConnectorRegistrationTokenRef,
		GitHubOAuthClientID:              "oauth-client-id",
		GitHubOAuthClientIDSource:        deployGitHubOAuthClientIDRef,
		GitHubToken:                      "github-token-value",
		GitHubTokenSource:                deployGitHubTokenRef,
		ProjectDomain:                    "example.com",
	}

	steps := strings.Join(deploySteps(project, options), "\n")
	for _, want := range []string{
		"docker network inspect traefik-public",
		"cat > .env <<'PROJECT_SPACE_ENV'",
		"deploy/compose.yml -f deploy/ingress.labels.yml",
		"PROJECT_DOMAIN=example.com",
		"PROJECT_API_DOMAIN=example-api.com",
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
	project := deployProject{RemotePath: "/opt/platform/apps/example"}
	options := deployOptions{
		APIDomain:                  "example-api.com",
		ClerkPublishableKey:        "clerk-publishable-value",
		ClerkSecretKey:             "clerk-secret-value",
		ConnectorRegistrationToken: "connector-registration-token-value",
		GitHubOAuthClientID:        "oauth-client-id",
		GitHubToken:                "github-token-value",
		ProjectDomain:              "example.com",
	}

	script := deployComposeScript(project, options, true)
	for _, want := range []string{
		"cat > .env <<'PROJECT_SPACE_ENV'",
		"PROJECT_DOMAIN=example.com",
		"PROJECT_API_DOMAIN=example-api.com",
		"GITHUB_TOKEN=github-token-value",
		"GITHUB_OAUTH_CLIENT_ID=oauth-client-id",
		"CLERK_PUBLISHABLE_KEY=clerk-publishable-value",
		"VITE_CLERK_PUBLISHABLE_KEY=clerk-publishable-value",
		"CLERK_SECRET_KEY=clerk-secret-value",
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN=connector-registration-token-value",
		"docker compose --env-file .env -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build",
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

	value, err := resolveDeployValue(cmd, bufio.NewReader(cmd.InOrStdin()), "deploy host", "host", "flag-value", []deployCandidate{
		{Value: "config-value", Source: "deploy/deploy.yaml"},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if value != "flag-value" {
		t.Fatalf("value = %q", value)
	}
}

func TestResolveDeployValueAcceptsDiscoveredValue(t *testing.T) {
	cmd := deployValueTestCommand("", "\n")

	value, err := resolveDeployValue(cmd, bufio.NewReader(cmd.InOrStdin()), "deploy host", "host", "", []deployCandidate{
		{Value: "deploy@100.84.238.75", Source: "deploy/deploy.yaml"},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if value != "deploy@100.84.238.75" {
		t.Fatalf("value = %q", value)
	}
	if !strings.Contains(cmd.OutOrStdout().(*bytes.Buffer).String(), "Use deploy host from deploy/deploy.yaml: deploy@100.84.238.75? Y/n") {
		t.Fatalf("prompt missing:\n%s", cmd.OutOrStdout().(*bytes.Buffer).String())
	}
}

func TestResolveDeployValueDeclinesDiscoveredValue(t *testing.T) {
	cmd := deployValueTestCommand("", "n\n")

	_, err := resolveDeployValue(cmd, bufio.NewReader(cmd.InOrStdin()), "deploy host", "host", "", []deployCandidate{
		{Value: "os-vps", Source: "deploy/deploy.yaml"},
	}, true)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "deploy host from deploy/deploy.yaml was declined") {
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
