package clientaccess

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/computeinventory"
)

func TestOpenUsesTheLocalTailnetAndDirectIPWithoutServerRelay(t *testing.T) {
	key := []byte("verified-environment-host-key")
	expected := fingerprint(key)
	keyscan := "100.64.0.10 ssh-ed25519 " + base64.StdEncoding.EncodeToString(key) + "\n"
	var commands []string
	var sshArgs []string
	dependencies := Dependencies{
		LookPath: func(name string) (string, error) { return "/usr/bin/" + name, nil },
		Run: func(_ context.Context, name string, args []string, _ []byte) (string, string, error) {
			commands = append(commands, name+" "+strings.Join(args, " "))
			if name == "tailscale" {
				return `{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.2"]}}`, "", nil
			}
			return keyscan, "", nil
		},
		Interactive: func(_ context.Context, _ io.Reader, _ io.Writer, _ io.Writer, name string, args []string) error {
			sshArgs = append([]string{name}, args...)
			return nil
		},
	}

	err := Open(context.Background(), Target{
		Address: "100.64.0.10", HostKeySHA256: expected, Port: 22,
		TargetIdentityRevision: "1:environment-key", User: "project-user",
	}, strings.NewReader(""), io.Discard, io.Discard, dependencies)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if len(commands) != 2 || !strings.HasPrefix(commands[0], "tailscale status --json") ||
		!strings.HasPrefix(commands[1], "ssh-keyscan -4 -p 22 100.64.0.10") {
		t.Fatalf("local commands = %#v", commands)
	}
	joined := strings.Join(sshArgs, " ")
	if !strings.Contains(joined, "project-user@100.64.0.10") || strings.Contains(joined, "projects.os-home.net") ||
		strings.Contains(joined, "credential") || !strings.Contains(joined, "StrictHostKeyChecking=yes") {
		t.Fatalf("ssh args = %#v", sshArgs)
	}
}

func TestOpenBlocksWhenTheViewingClientIsNotOnTheTailnet(t *testing.T) {
	keyscanCalled := false
	dependencies := Dependencies{
		LookPath: func(name string) (string, error) { return "/usr/bin/" + name, nil },
		Run: func(_ context.Context, name string, _ []string, _ []byte) (string, string, error) {
			if name == "ssh-keyscan" {
				keyscanCalled = true
			}
			return `{"BackendState":"Stopped","Self":{"TailscaleIPs":[]}}`, "", nil
		},
		Interactive: func(context.Context, io.Reader, io.Writer, io.Writer, string, []string) error {
			t.Fatal("interactive SSH must not start")
			return nil
		},
	}
	err := Open(context.Background(), Target{
		Address: "100.64.0.10", HostKeySHA256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Port: 22,
		TargetIdentityRevision: "1:environment-key", User: "project-user",
	}, strings.NewReader(""), io.Discard, io.Discard, dependencies)
	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != CodeTailnetUnavailable || keyscanCalled {
		t.Fatalf("error = %v, keyscanCalled = %t", err, keyscanCalled)
	}
}

func TestOpenDistinguishesLocalClientAndHostKeyFailures(t *testing.T) {
	missingTailscale := Dependencies{
		LookPath: func(name string) (string, error) {
			if name == "tailscale" {
				return "", errors.New("not found")
			}
			return "/usr/bin/" + name, nil
		},
		Run: func(context.Context, string, []string, []byte) (string, string, error) {
			t.Fatal("run must not start")
			return "", "", nil
		},
		Interactive: func(context.Context, io.Reader, io.Writer, io.Writer, string, []string) error {
			t.Fatal("ssh must not start")
			return nil
		},
	}
	err := Open(context.Background(), validTarget(), strings.NewReader(""), io.Discard, io.Discard, missingTailscale)
	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != CodeLocalClientUnavailable {
		t.Fatalf("local failure = %v", err)
	}

	keyscanMismatch := DefaultDependencies()
	keyscanMismatch.LookPath = func(name string) (string, error) { return "/usr/bin/" + name, nil }
	keyscanMismatch.Run = func(_ context.Context, name string, _ []string, _ []byte) (string, string, error) {
		if name == "tailscale" {
			return `{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.2"]}}`, "", nil
		}
		return "100.64.0.10 ssh-ed25519 " + base64.StdEncoding.EncodeToString([]byte("different-key")), "", nil
	}
	keyscanMismatch.Interactive = func(context.Context, io.Reader, io.Writer, io.Writer, string, []string) error {
		t.Fatal("ssh must not start")
		return nil
	}
	err = Open(context.Background(), validTarget(), strings.NewReader(""), io.Discard, io.Discard, keyscanMismatch)
	if !errors.As(err, &failure) || failure.Code != CodeHostKeyMismatch {
		t.Fatalf("host-key failure = %v", err)
	}
}

func TestTargetFromRouteRejectsStaleAndNonTailnetRoutes(t *testing.T) {
	for _, route := range []computeinventory.AccessRoute{
		{ProviderKind: "tailscale", State: "stale", Type: "ssh_private_network"},
		{ProviderKind: "wireguard", State: "ready", Type: "ssh_private_network", ClientAccess: &computeinventory.ClientAccess{Address: "100.64.0.10", HostKeySHA256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Port: 22, TargetIdentityRevision: "1:environment-key", User: "project-user"}},
	} {
		_, err := TargetFromRoute(route)
		var failure *Failure
		if !errors.As(err, &failure) || failure.Code != CodeTargetUnavailable {
			t.Fatalf("route %#v error = %v", route, err)
		}
	}
}

func TestClassifySSHFailureSeparatesAuthenticationFromTarget(t *testing.T) {
	if got := classifySSHFailure(errors.New("exit status 255"), "Permission denied (publickey)"); got.Code != CodeAuthenticationFailed {
		t.Fatalf("authentication = %#v", got)
	}
	if got := classifySSHFailure(errors.New("exit status 255"), "Connection timed out"); got.Code != CodeTargetUnavailable {
		t.Fatalf("target = %#v", got)
	}
}

func validTarget() Target {
	return Target{
		Address: "100.64.0.10", HostKeySHA256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Port: 22,
		TargetIdentityRevision: "1:environment-key", User: "project-user",
	}
}

func fingerprint(value []byte) string {
	digest := sha256.Sum256(value)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:])
}
