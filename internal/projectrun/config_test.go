package projectrun

import (
	"errors"
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
		{"unknown field", "version: 1\nscripts:\n  dev:\n    command: [bun, run, dev]\n    environment: {TOKEN: secret}\n", "field environment not found"},
		{"wrong version", "version: 2\nscripts:\n  dev:\n    command: [bun, run, dev]\n", "version must be 1"},
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
