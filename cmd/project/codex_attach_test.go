package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestResolveCodexBinarySkipsBrokenPathAndUsesWorkingBundle(t *testing.T) {
	home := t.TempDir()
	broken := filepath.Join(t.TempDir(), "codex")
	bundled := filepath.Join(home, "Applications/ChatGPT.app/Contents/Resources/codex")
	for _, candidate := range []string{broken, bundled} {
		if err := os.MkdirAll(filepath.Dir(candidate), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(candidate, []byte("test executable"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	resolved, err := resolveCodexBinaryWith(context.Background(), "", codexBinaryDiscovery{
		lookupEnv: func(string) (string, bool) { return "", false },
		lookPath:  func(string) (string, error) { return broken, nil },
		userHome:  func() (string, error) { return home, nil },
		probe: func(_ context.Context, candidate string) error {
			if candidate == bundled {
				return nil
			}
			return errors.New("native binary missing")
		},
	})
	if err != nil || resolved != bundled {
		t.Fatalf("resolved = %q error = %v", resolved, err)
	}
}

func TestResolveCodexBinaryTreatsExplicitOverrideAsAuthoritative(t *testing.T) {
	explicit := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(explicit, []byte("broken"), 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := resolveCodexBinaryWith(context.Background(), explicit, codexBinaryDiscovery{
		lookupEnv: func(string) (string, bool) { return "", false },
		lookPath:  func(string) (string, error) { t.Fatal("PATH fallback used"); return "", nil },
		userHome:  os.UserHomeDir,
		probe:     func(context.Context, string) error { return errors.New("broken") },
	})
	if err == nil || !strings.Contains(err.Error(), "not working") || strings.Contains(err.Error(), "broken") {
		t.Fatalf("error = %v", err)
	}
}

func TestCodexAttachEndpointIsPrivateAndArgumentsContainNoToken(t *testing.T) {
	directory, socketPath, err := createPrivateCodexAttachEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	info, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 || filepath.Dir(socketPath) != directory {
		t.Fatalf("directory mode = %o socket = %q", info.Mode().Perm(), socketPath)
	}
	if arguments := codexAppServerArguments(socketPath); !slices.Equal(arguments, []string{"app-server", "--listen", "unix://" + socketPath}) {
		t.Fatalf("app-server arguments = %q", arguments)
	}
	if arguments := codexResumeArguments(socketPath, codexTestThreadID); !slices.Equal(arguments, []string{"resume", "--remote", "unix://" + socketPath, codexTestThreadID}) {
		t.Fatalf("resume arguments = %q", arguments)
	}
}

func TestCodexRemoteAttachKeepsTokenOutOfArgumentsAndReplacesInheritedSecret(t *testing.T) {
	t.Setenv(codexAttachTokenEnvironment, "old-secret")
	arguments := codexRemoteResumeArguments(
		"wss://projects.example/api/codex/tasks/thread/attach/socket",
		codexTestThreadID,
	)
	if strings.Contains(strings.Join(arguments, " "), "new-secret") ||
		!slices.Contains(arguments, codexAttachTokenEnvironment) {
		t.Fatalf("remote arguments = %q", arguments)
	}
	environment := codexRemoteAttachEnvironment("new-secret")
	values := make([]string, 0, 1)
	for _, entry := range environment {
		if strings.HasPrefix(entry, codexAttachTokenEnvironment+"=") {
			values = append(values, entry)
		}
	}
	if !slices.Equal(values, []string{codexAttachTokenEnvironment + "=new-secret"}) {
		t.Fatalf("token environment = %q", values)
	}
}
