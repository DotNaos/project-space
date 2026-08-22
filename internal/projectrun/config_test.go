package projectrun

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadScriptUsesStrictVersionedArgumentList(t *testing.T) {
	project := t.TempDir()
	writeScriptsBody(t, project, "version: 1\nscripts:\n  dev:\n    command: [bun, run, dev, --, --host, \"{host}\", --port, \"{port}\"]\n")
	root, script, err := LoadScript(project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	if root != canonical || strings.Join(script.Command, " ") != "bun run dev -- --host {host} --port {port}" {
		t.Fatalf("root=%q script=%#v", root, script)
	}
}

func TestLoadScriptRejectsShellStringAndUnknownFields(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{"shell string", "version: 1\nscripts:\n  dev:\n    command: bun run dev\n", "cannot unmarshal"},
		{"unknown field", "version: 1\nscripts:\n  dev:\n    command: [bun, run, dev]\n    environmentVariables: {TOKEN: secret}\n", "field environmentVariables not found"},
		{"wrong version shape", "version: 2\nscripts:\n  dev:\n    command: [bun, run, dev]\n", "version 2 uses servers"},
		{"extra document", "version: 1\nscripts:\n  dev:\n    command: [bun, run, dev]\n---\nversion: 1\n", "multiple YAML documents"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			project := t.TempDir()
			writeScriptsBody(t, project, test.body)
			_, _, err := LoadScript(project, "dev")
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestLoadDeclarationPreservesTrustedSetupOrder(t *testing.T) {
	project := t.TempDir()
	writeScriptsBody(t, project, "version: 2\nsetup:\n  - id: tools\n    command: [bun, install, --frozen-lockfile]\n  - id: generate\n    command: [bun, run, generate]\nservers:\n  web:\n    label: Web app\n    command: [bun, run, dev]\n")
	declaration, err := LoadDeclaration(project)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(declaration.SetupNames(), ","); got != "tools,generate" {
		t.Fatalf("setup order = %q", got)
	}
	if declaration.Digest == "" || declaration.Server["web"].Label != "Web app" {
		t.Fatalf("declaration = %#v", declaration)
	}
}

func TestLoadDeclarationBindsPrototypeSurfaceToServer(t *testing.T) {
	project := t.TempDir()
	writeScriptsBody(t, project, "version: 2\nsetup:\n  - id: tools\n    command: [bun, install]\nservers:\n  prototype-desktop:\n    prototypeSurface: desktop-prototype\n    command: [bun, run, prototype]\n")
	declaration, err := LoadDeclaration(project)
	if err != nil {
		t.Fatal(err)
	}
	if declaration.Server["prototype-desktop"].PrototypeSurface != "desktop-prototype" {
		t.Fatalf("declaration = %#v", declaration)
	}

	writeScriptsBody(t, project, "version: 2\nsetup:\n  - id: tools\n    command: [bun, install]\nservers:\n  prototype:\n    prototypeSurface: full-preview\n    command: [bun, run, prototype]\n")
	if _, err := LoadDeclaration(project); err == nil ||
		!strings.Contains(err.Error(), "prototypeSurface") {
		t.Fatalf("invalid surface error = %v", err)
	}
}

func TestVersionThreeSeparatesFiniteCommandsFromServersAndKeepsEnvironment(t *testing.T) {
	project := t.TempDir()
	writeScriptsBody(t, project, `version: 3
setup:
  - id: dependencies
    command: [bun, install]
commands:
  test:
    command: [bun, test]
servers:
  dev:
    command: [bun, x, vite, --port, "{port}"]
    environment:
      VITE_PROJECT_SPACE_API_BASE_URL: http://127.0.0.1:45873
      VITE_PROJECT_SPACE_AUTH_DISABLED: "1"
      PROJECT_SPACE_AUTH_DISABLED: "1"
      PROJECT_SPACE_PUBLIC_ORIGIN: ""
    externalEnvironment:
      VITE_PROJECT_SPACE_AUTH_DISABLED: "0"
      PROJECT_SPACE_AUTH_DISABLED: "0"
    secretEnvironment:
      GITHUB_OAUTH_CLIENT_ID: infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID
`)
	root, command, err := LoadCommand(project, "test")
	if err != nil || root == "" || strings.Join(command.Command, " ") != "bun test" {
		t.Fatalf("command root=%q declaration=%#v err=%v", root, command, err)
	}
	_, server, err := LoadScript(project, "dev")
	if err != nil || server.Environment["VITE_PROJECT_SPACE_API_BASE_URL"] != "http://127.0.0.1:45873" {
		t.Fatalf("server = %#v err=%v", server, err)
	}
	if server.Environment["PROJECT_SPACE_AUTH_DISABLED"] != "1" ||
		server.Environment["VITE_PROJECT_SPACE_AUTH_DISABLED"] != "1" ||
		server.Environment["PROJECT_SPACE_PUBLIC_ORIGIN"] != "" ||
		server.SecretEnvironment["GITHUB_OAUTH_CLIENT_ID"] != "infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID" {
		t.Fatalf("managed local preview environment = %#v", server)
	}
	if server.ExternalEnvironment["PROJECT_SPACE_AUTH_DISABLED"] != "0" ||
		server.ExternalEnvironment["VITE_PROJECT_SPACE_AUTH_DISABLED"] != "0" {
		t.Fatalf("external environment = %#v", server.ExternalEnvironment)
	}
	if _, _, err := LoadCommand(project, "dev"); err == nil ||
		!strings.Contains(err.Error(), "long-running servers require project serve") {
		t.Fatalf("server escaped through project run: %v", err)
	}
}

func TestExternalServeUsesOverridesAndNamedSecretsAcrossInfisicalProjects(t *testing.T) {
	project := t.TempDir()
	writeScriptsBody(t, project, `version: 1
scripts:
  dev:
    command: [bun, x, vite]
    environment:
      PROJECT_SPACE_AUTH_DISABLED: "1"
    externalEnvironment:
      PROJECT_SPACE_AUTH_DISABLED: "0"
    secretEnvironment:
      DATABASE_URL: infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/DATABASE_URL
      CLERK_SECRET_KEY: infisical://467bbc88-262a-4ea0-a238-9666d6e7e359/prod/CLERK_SECRET_KEY
`)
	_, script, err := LoadScript(project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	command := serverCommandFor(
		script, project, "127.0.0.1", 43117, nil, ServeModeManaged,
		"http://project.localhost:1355", "http://100.64.0.8:44419",
		APIsModeExternal, DataModeRemote,
	)
	if !containsEnvironment(command.Env, "PROJECT_SPACE_AUTH_DISABLED=0") ||
		!containsEnvironment(command.Env, "PROJECT_SPACE_EXTERNAL_SECRETS=resolved") {
		t.Fatalf("external environment = %#v", command.Env)
	}
	if len(command.SecretEnvironment) != 2 || command.SecretEnvironment["DATABASE_URL"] == "" ||
		command.SecretEnvironment["CLERK_SECRET_KEY"] == "" {
		t.Fatalf("external secrets = %#v", command.SecretEnvironment)
	}
}

func TestSecretEnvironmentRequiresInfisicalReferencesAndDistinctKeys(t *testing.T) {
	project := t.TempDir()
	for _, body := range []string{
		"version: 1\nscripts:\n  dev:\n    command: [true]\n    secretEnvironment: {TOKEN: plaintext}\n",
		"version: 1\nscripts:\n  dev:\n    command: [true]\n    environment: {TOKEN: value}\n    secretEnvironment: {TOKEN: infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/TOKEN}\n",
	} {
		writeScriptsBody(t, project, body)
		if _, _, err := LoadScript(project, "dev"); err == nil {
			t.Fatalf("unsafe secret environment was accepted: %s", body)
		}
	}
}

func TestSecretEnvironmentDeclaresOnlyNamedInfisicalValues(t *testing.T) {
	script := Script{
		Command: []string{"bun", "x", "vite"},
		SecretEnvironment: map[string]string{
			"GITHUB_OAUTH_CLIENT_ID": "infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID",
		},
	}
	command := commandFor(script, "/tmp/project", "127.0.0.1", 43117, nil)
	if got := strings.Join(command.Argv, " "); got != "bun x vite" {
		t.Fatalf("command = %q", got)
	}
	if got := command.SecretEnvironment["GITHUB_OAUTH_CLIENT_ID"]; got != "infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID" {
		t.Fatalf("secret declaration = %q", got)
	}
	if containsEnvironment(command.Env, "GITHUB_OAUTH_CLIENT_ID=infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID") {
		t.Fatalf("opaque Infisical reference leaked into command environment: %#v", command.Env)
	}
}

func TestManagedServeMarkerCannotEscapeIntoFiniteCommands(t *testing.T) {
	script := Script{Command: []string{"bun", "x", "vite", "--port", "{port}"}}
	finite := commandFor(script, "/tmp/project", "127.0.0.1", 43117, nil)
	if containsEnvironment(finite.Env, "PROJECT_SPACE_MANAGED_SERVE=1") ||
		containsEnvironment(finite.Env, "PROJECT_SPACE_SERVE_MODE=managed") {
		t.Fatalf("finite command received serve authority: %#v", finite.Env)
	}
	server := serverCommandFor(
		script, "/tmp/project", "127.0.0.1", 43117, nil, ServeModeManaged,
		"http://project.localhost:1355", "http://100.64.0.8:44419",
		APIsModeExternal, DataModeRemote,
	)
	if !containsEnvironment(server.Env, "PROJECT_SPACE_MANAGED_SERVE=1") ||
		!containsEnvironment(server.Env, "PROJECT_SPACE_SERVE_MODE=managed") {
		t.Fatalf("server command is missing serve authority: %#v", server.Env)
	}
	if !containsEnvironment(server.Env, "PORTLESS_URL=http://project.localhost:1355") {
		t.Fatalf("server command is missing Portless URL: %#v", server.Env)
	}
	if !containsEnvironment(server.Env, "PROJECT_SPACE_RUNTIME_ACCESS_URL=http://100.64.0.8:44419") {
		t.Fatalf("server command is missing runtime access URL: %#v", server.Env)
	}
}

func TestSimulatedServeDoesNotLoadDeclaredSecrets(t *testing.T) {
	script := Script{
		Command: []string{"bun", "x", "vite"},
		SecretEnvironment: map[string]string{
			"GITHUB_OAUTH_CLIENT_ID": "infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID",
		},
	}
	command := serverCommandFor(
		script, "/tmp/project", "127.0.0.1", 43117, nil, ServeModeManaged,
		"http://project.localhost:1355", "http://100.64.0.8:44419",
		APIsModeSimulated, DataModeLocal,
	)
	if got := strings.Join(command.Argv, " "); got != "bun x vite" {
		t.Fatalf("command = %q", got)
	}
	if containsEnvironment(command.Env, "GITHUB_OAUTH_CLIENT_ID=infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID") {
		t.Fatalf("simulated command loaded an external secret: %#v", command.Env)
	}
	if len(command.SecretEnvironment) != 0 {
		t.Fatalf("simulated command retained external secret declarations: %#v", command.SecretEnvironment)
	}
	for _, expected := range []string{
		"PROJECT_SPACE_APIS=simulated",
		"PROJECT_SPACE_DATA=local",
	} {
		if !containsEnvironment(command.Env, expected) {
			t.Fatalf("command environment is missing %q: %#v", expected, command.Env)
		}
	}
}

func TestLoadDeclarationBoundsStepAndServerCountsAndIdentifiers(t *testing.T) {
	project := t.TempDir()
	setup := make([]string, 0, maximumSetupSteps+1)
	for index := 0; index <= maximumSetupSteps; index++ {
		setup = append(setup, fmt.Sprintf("  - id: step.%d\n    command: [true]", index))
	}
	writeScriptsBody(t, project, "version: 2\nsetup:\n"+strings.Join(setup, "\n")+"\nservers:\n  dev:\n    command: [true]\n")
	if _, err := LoadDeclaration(project); err == nil || !strings.Contains(err.Error(), "at most 64 steps") {
		t.Fatalf("setup bound error = %v", err)
	}

	servers := make([]string, 0, maximumServers+1)
	for index := 0; index <= maximumServers; index++ {
		servers = append(servers, fmt.Sprintf("  server.%d:\n    command: [true]", index))
	}
	writeScriptsBody(t, project, "version: 2\nsetup:\n  - id: dependencies\n    command: [true]\nservers:\n"+strings.Join(servers, "\n")+"\n")
	if _, err := LoadDeclaration(project); err == nil || !strings.Contains(err.Error(), "at most 64 entries") {
		t.Fatalf("server bound error = %v", err)
	}

	writeScriptsBody(t, project, "version: 2\nsetup:\n  - id: "+strings.Repeat("a", 65)+"\n    command: [true]\nservers:\n  dev:\n    command: [true]\n")
	if _, err := LoadDeclaration(project); err == nil || !strings.Contains(err.Error(), "setup step name") {
		t.Fatalf("identifier bound error = %v", err)
	}
}

func TestLoadDeclarationRejectsDuplicateSetupIDsAndShellCommands(t *testing.T) {
	project := t.TempDir()
	writeScriptsBody(t, project, "version: 2\nsetup:\n  - id: install\n    command: [bun, install]\n  - id: install\n    command: [bun, run, generate]\nservers:\n  dev:\n    command: [bun, run, dev]\n")
	if _, err := LoadDeclaration(project); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("duplicate error = %v", err)
	}
	writeScriptsBody(t, project, "version: 2\nsetup:\n  - id: install\n    command: bun install\nservers:\n  dev:\n    command: [bun, run, dev]\n")
	if _, err := LoadDeclaration(project); err == nil || !strings.Contains(err.Error(), "cannot unmarshal") {
		t.Fatalf("shell command error = %v", err)
	}
}

func TestStatusSentinelsDistinguishMissingConfiguration(t *testing.T) {
	project := t.TempDir()
	_, _, err := LoadScript(project, "dev")
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("error = %v", err)
	}
	writeScriptsBody(t, project, "version: 1\nscripts:\n  test:\n    command: [go, test, ./...]\n")
	_, _, err = LoadScript(project, "dev")
	if !errors.Is(err, ErrScriptNotFound) {
		t.Fatalf("error = %v", err)
	}
}

func TestAllowedHostsAreExplicitAndStrict(t *testing.T) {
	hosts, err := NormalizeAllowedHosts([]string{"Preview.Example.com", "100.80.135.9", "preview.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(hosts, ",") != "100.80.135.9,preview.example.com" {
		t.Fatalf("hosts = %#v", hosts)
	}
	for _, invalid := range []string{
		"*", ".example.com", "https://example.com", "example.com:443", "example.com/path", "a.example,b.example",
	} {
		if _, err := NormalizeAllowedHosts([]string{invalid}); err == nil {
			t.Fatalf("expected %q to be rejected", invalid)
		}
	}
}

func TestSafeEnvironmentDoesNotExposeConnectorSecrets(t *testing.T) {
	environment := safeEnvironment([]string{
		"PATH=/usr/bin", "HOME=/tmp/home", "LANG=en_US.UTF-8",
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN=secret",
		"CLERK_SECRET_KEY=secret", "DATABASE_URL=secret", "GITHUB_TOKEN=secret",
	})
	joined := strings.Join(environment, "\n")
	if !strings.Contains(joined, "PATH=/usr/bin") || !strings.Contains(joined, "HOME=/tmp/home") {
		t.Fatalf("safe environment lost runtime values: %q", joined)
	}
	for _, secret := range []string{"PROJECT_CONNECTOR", "CLERK", "DATABASE_URL", "GITHUB_TOKEN"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("safe environment leaked %s: %q", secret, joined)
		}
	}
}

func writeScriptsBody(t *testing.T, project, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(project, ".project"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, scriptsConfigPath), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
