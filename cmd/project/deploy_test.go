package main

import (
	"strings"
	"testing"
)

func TestDeployStepsUseExistingComposeFiles(t *testing.T) {
	project := deployProject{
		RemoteURL:  "https://github.com/DotNaos/example",
		RemotePath: "/opt/projects/example",
		Branch:     "main",
	}
	options := deployOptions{ProjectDomain: "example.com", AcmeEmail: "ops@example.com"}

	steps := strings.Join(deploySteps(project, options), "\n")
	for _, want := range []string{
		"deploy/ingress.compose.yml",
		"deploy/compose.yml -f deploy/ingress.labels.yml",
		"PROJECT_DOMAIN=example.com",
		"TRAEFIK_ACME_EMAIL=ops@example.com",
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
