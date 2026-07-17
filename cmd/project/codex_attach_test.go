package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
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

func TestCodexRemoteAttachBridgeRewritesTheLoopbackHandshakeAndRelaysBytes(t *testing.T) {
	path := make(chan string, 1)
	authorization := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		path <- request.URL.Path
		authorization <- request.Header.Get("Authorization")
		connection, buffered, err := response.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = buffered.Flush()
		_, _ = io.Copy(connection, connection)
	}))
	defer server.Close()

	bridge, err := startCodexAttachBridge(
		context.Background(),
		"ws"+strings.TrimPrefix(server.URL, "http")+"/api/codex/tasks/thread/attach/socket",
	)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.stop()
	connection, err := net.Dial("tcp", strings.TrimPrefix(bridge.remoteURL(), "ws://"))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_, err = fmt.Fprint(connection, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer attach-secret\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	if status, err := reader.ReadString('\n'); err != nil || !strings.Contains(status, "101 Switching Protocols") {
		t.Fatalf("status = %q error = %v", status, err)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	if _, err := connection.Write([]byte("relay")); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, len("relay"))
	if _, err := io.ReadFull(reader, echo); err != nil || string(echo) != "relay" {
		t.Fatalf("echo = %q error = %v", echo, err)
	}
	if got := <-path; got != "/api/codex/tasks/thread/attach/socket" {
		t.Fatalf("path = %q", got)
	}
	if got := <-authorization; got != "Bearer attach-secret" {
		t.Fatalf("authorization = %q", got)
	}
}
