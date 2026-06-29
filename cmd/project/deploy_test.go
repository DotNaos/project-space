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
	options := deployOptions{ProjectDomain: "example.com", APIDomain: "example-api.com"}

	steps := strings.Join(deploySteps(project, options), "\n")
	for _, want := range []string{
		"docker network inspect traefik-public",
		"deploy/compose.yml -f deploy/ingress.labels.yml",
		"PROJECT_DOMAIN=example.com",
		"PROJECT_API_DOMAIN=example-api.com",
	} {
		if !strings.Contains(steps, want) {
			t.Fatalf("deploy steps missing %q:\n%s", want, steps)
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
