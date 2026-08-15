package main

import (
	"bytes"
	"errors"
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
			"CLERK_PUBLISHABLE_KEY":      {Value: "clerk-publishable-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/CLERK_PUBLISHABLE_KEY"},
			"CLERK_SECRET_KEY":           {Value: "clerk-secret-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/CLERK_SECRET_KEY"},
			"GITHUB_OAUTH_CLIENT_ID":     {Value: "oauth-client-id", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/GITHUB_OAUTH_CLIENT_ID"},
			"GITHUB_TOKEN":               {Value: "github-token-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/GITHUB_TOKEN"},
			"EXAMPLE_RUNTIME_SECRET":     {Value: "runtime-secret-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/EXAMPLE_RUNTIME_SECRET"},
			"VITE_CLERK_PUBLISHABLE_KEY": {Value: "clerk-publishable-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/CLERK_PUBLISHABLE_KEY"},
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
		"GITHUB_TOKEN=<secret from infisical://00000000-0000-4000-8000-000000000000/prod/GITHUB_TOKEN>",
		"GITHUB_OAUTH_CLIENT_ID=<secret from infisical://00000000-0000-4000-8000-000000000000/prod/GITHUB_OAUTH_CLIENT_ID>",
		"CLERK_PUBLISHABLE_KEY=<secret from infisical://00000000-0000-4000-8000-000000000000/prod/CLERK_PUBLISHABLE_KEY>",
		"VITE_CLERK_PUBLISHABLE_KEY=<secret from infisical://00000000-0000-4000-8000-000000000000/prod/CLERK_PUBLISHABLE_KEY>",
		"CLERK_SECRET_KEY=<secret from infisical://00000000-0000-4000-8000-000000000000/prod/CLERK_SECRET_KEY>",
		"EXAMPLE_RUNTIME_SECRET=<secret from infisical://00000000-0000-4000-8000-000000000000/prod/EXAMPLE_RUNTIME_SECRET>",
	} {
		if !strings.Contains(steps, want) {
			t.Fatalf("deploy steps missing %q:\n%s", want, steps)
		}
	}
	if strings.Contains(steps, "github-token-value") ||
		strings.Contains(steps, "oauth-client-id") ||
		strings.Contains(steps, "clerk-publishable-value") ||
		strings.Contains(steps, "clerk-secret-value") ||
		strings.Contains(steps, "runtime-secret-value") {
		t.Fatalf("deploy dry-run steps leaked secret values:\n%s", steps)
	}
}

func TestResolveDeploySecretsUsesExactNonImportedLookup(t *testing.T) {
	previous := runSecretExternalCommand
	t.Cleanup(func() { runSecretExternalCommand = previous })
	var executable string
	var arguments []string
	runSecretExternalCommand = func(name string, args ...string) (string, error) {
		executable = name
		arguments = append([]string(nil), args...)
		return "selected-value\n", nil
	}
	secrets, err := resolveDeploySecrets(map[string]string{
		"DECLARED_SECRET": "infisical://00000000-0000-4000-8000-000000000000/prod/DECLARED_SECRET",
	})
	if err != nil {
		t.Fatal(err)
	}
	if executable != "infisical" || len(arguments) < 3 ||
		strings.Join(arguments[:3], " ") != "secrets get DECLARED_SECRET" {
		t.Fatalf("lookup = %q %q", executable, arguments)
	}
	joined := strings.Join(arguments, "\n")
	for _, expected := range []string{"--path=/", "--include-imports=false", "--recursive=false"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("lookup missing %s: %q", expected, arguments)
		}
	}
	if secrets["DECLARED_SECRET"].Value != "selected-value" {
		t.Fatal("resolved value was not retained in memory")
	}
}

func TestSecretExternalCommandDoesNotReturnFailureOutput(t *testing.T) {
	bin := t.TempDir()
	path := filepath.Join(bin, "infisical")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s\\n' sensitive-stdout\nprintf '%s\\n' sensitive-stderr >&2\nexit 9\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := executeSecretExternalCommand("infisical", "secrets", "get", "DECLARED_SECRET")
	if err == nil {
		t.Fatal("failed secret lookup was accepted")
	}
	if strings.Contains(err.Error(), "sensitive-") {
		t.Fatalf("secret lookup output leaked through the error: %v", err)
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) && len(exitError.Stderr) != 0 {
		t.Fatal("secret lookup stderr remained attached to the returned error")
	}
}

func TestDeployComposeScriptUsesSecretValuesOnlyAtRuntime(t *testing.T) {
	project := deployProject{Environment: "prod", RemotePath: "/opt/platform/apps/example", ComposeProject: "example-prod"}
	options := deployOptions{
		APIDomain:     "api.example.com",
		ProjectDomain: "example.com",
		Secrets: map[string]deploySecretValue{
			"CLERK_PUBLISHABLE_KEY":  {Value: "clerk-publishable-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/CLERK_PUBLISHABLE_KEY"},
			"CLERK_SECRET_KEY":       {Value: "clerk-secret-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/CLERK_SECRET_KEY"},
			"GITHUB_OAUTH_CLIENT_ID": {Value: "oauth-client-id", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/GITHUB_OAUTH_CLIENT_ID"},
			"GITHUB_TOKEN":           {Value: "github-token-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/GITHUB_TOKEN"},
			"EXAMPLE_RUNTIME_SECRET": {Value: "runtime-secret-value", Source: "infisical://00000000-0000-4000-8000-000000000000/prod/EXAMPLE_RUNTIME_SECRET"},
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
		"EXAMPLE_RUNTIME_SECRET='runtime-secret-value'",
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
