package main

import (
	"bytes"
	"os"
	"os/exec"
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
		"umask 077",
		`project_env_tmp="$(mktemp .env.tmp.XXXXXX)"`,
		`cat > "$project_env_tmp" <<'PROJECT_SPACE_ENV'`,
		`chmod 600 "$project_env_tmp"`,
		`mv -f -- "$project_env_tmp" .env`,
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
		"umask 077",
		`project_env_tmp="$(mktemp .env.tmp.XXXXXX)"`,
		`cat > "$project_env_tmp" <<'PROJECT_SPACE_ENV'`,
		`chmod 600 "$project_env_tmp"`,
		`mv -f -- "$project_env_tmp" .env`,
		"PROJECT_DOMAIN=example.com",
		"PROJECT_API_DOMAIN=api.example.com",
		"GITHUB_TOKEN='github-token-value'",
		"GITHUB_OAUTH_CLIENT_ID='oauth-client-id'",
		"CLERK_PUBLISHABLE_KEY='clerk-publishable-value'",
		"CLERK_SECRET_KEY='clerk-secret-value'",
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN='connector-registration-token-value'",
		"docker compose --env-file .env -p example-prod -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("runtime deploy script missing %q:\n%s", want, script)
		}
	}
}

func TestDeployEnvironmentQuotesSecretInterpolationCharacters(t *testing.T) {
	content := deployEnvFileContent(deployProject{}, deployOptions{Secrets: map[string]deploySecretValue{
		"SPECIAL": {Value: `abc$HOME#suffix'\\tail`},
	}}, true)
	if !strings.Contains(content, `SPECIAL='abc$HOME#suffix\'\\\\tail'`) {
		t.Fatalf("secret was not dotenv-escaped: %s", content)
	}
}

func TestDeployComposeScriptWritesEnvironmentFileAtomicallyWithOwnerOnlyPermissions(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.Mkdir(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWriteDeployTestFile(t, filepath.Join(binDir, "docker"), "#!/bin/sh\nexit 0\n")
	if err := os.Chmod(filepath.Join(binDir, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("OLD=value\n"), 0o666); err != nil {
		t.Fatal(err)
	}

	project := deployProject{
		Environment:    "prod",
		RemotePath:     root,
		ComposeProject: "example-prod",
	}
	options := deployOptions{
		ProjectDomain: "example.com",
		Secrets: map[string]deploySecretValue{
			"PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET": {Value: strings.Repeat("s", 32)},
		},
	}
	command := exec.Command("sh", "-c", deployComposeScript(project, options, true))
	command.Env = append(os.Environ(), "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("run deploy compose script: %v\n%s", err, output)
	}

	environmentPath := filepath.Join(root, ".env")
	info, err := os.Stat(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf(".env permissions = %o, want 600", got)
	}
	body, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET='"+strings.Repeat("s", 32)+"'") {
		t.Fatalf(".env missing configured secret")
	}
	matches, err := filepath.Glob(filepath.Join(root, ".env.tmp.*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary environment files remain: %v", matches)
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
