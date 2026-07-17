package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const codexAttachSocketTimeout = 10 * time.Second
const codexAttachTokenEnvironment = "PROJECT_CODEX_ATTACH_TOKEN"

type codexBinaryDiscovery struct {
	lookupEnv func(string) (string, bool)
	lookPath  func(string) (string, error)
	probe     func(context.Context, string) error
	userHome  func() (string, error)
}

func resolveCodexBinary(ctx context.Context, explicit string) (string, error) {
	return resolveCodexBinaryWith(ctx, explicit, codexBinaryDiscovery{
		lookupEnv: os.LookupEnv, lookPath: exec.LookPath,
		probe: probeCodexBinary, userHome: os.UserHomeDir,
	})
}

func resolveCodexBinaryWith(ctx context.Context, explicit string, discovery codexBinaryDiscovery) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		return validateCodexBinary(ctx, explicit, discovery.probe)
	}
	if configured, ok := discovery.lookupEnv("PROJECT_CODEX_BINARY"); ok && strings.TrimSpace(configured) != "" {
		return validateCodexBinary(ctx, configured, discovery.probe)
	}

	candidates := make([]string, 0, 6)
	if fromPath, err := discovery.lookPath("codex"); err == nil {
		candidates = append(candidates, fromPath)
	}
	candidates = append(candidates,
		"/Applications/Codex.app/Contents/Resources/codex",
		"/Applications/ChatGPT.app/Contents/Resources/codex",
	)
	if home, err := discovery.userHome(); err == nil && home != "" {
		candidates = append(candidates,
			filepath.Join(home, "Applications/Codex.app/Contents/Resources/codex"),
			filepath.Join(home, "Applications/ChatGPT.app/Contents/Resources/codex"),
		)
	}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		resolved, err := filepath.Abs(candidate)
		if err != nil || seen[resolved] {
			continue
		}
		seen[resolved] = true
		if binary, err := validateCodexBinary(ctx, resolved, discovery.probe); err == nil {
			return binary, nil
		}
	}
	return "", errors.New("no working Codex CLI was found; install Codex or use --codex-binary")
}

func validateCodexBinary(ctx context.Context, candidate string, probe func(context.Context, string) error) (string, error) {
	resolved, err := filepath.Abs(strings.TrimSpace(candidate))
	if err != nil {
		return "", errors.New("the configured Codex CLI path is invalid")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("Codex CLI is not an executable file: %s", resolved)
	}
	if err := probe(ctx, resolved); err != nil {
		return "", fmt.Errorf("Codex CLI is not working: %s", resolved)
	}
	return resolved, nil
}

func probeCodexBinary(ctx context.Context, binary string) error {
	probeContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(probeContext, binary, "--version")
	command.Stdout, command.Stderr = io.Discard, io.Discard
	return command.Run()
}

type codexAppServerProcess struct {
	command *exec.Cmd
	done    chan struct{}
}

func runLocalCodexAttach(
	ctx context.Context,
	binary string,
	threadID string,
	input io.Reader,
	output io.Writer,
	errorOutput io.Writer,
) error {
	directory, socketPath, err := createPrivateCodexAttachEndpoint()
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	server, err := startCodexAppServer(binary, socketPath, errorOutput)
	if err != nil {
		return err
	}
	defer server.stop()
	if err := waitForCodexSocket(ctx, socketPath, server); err != nil {
		return err
	}

	resume := exec.CommandContext(ctx, binary, codexResumeArguments(socketPath, threadID)...)
	resume.Stdin, resume.Stdout, resume.Stderr = input, output, errorOutput
	resume.Env = os.Environ()
	if err := resume.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Codex TUI attachment ended with an error")
	}
	return nil
}

func runRemoteCodexAttach(
	ctx context.Context,
	binary string,
	remoteURL string,
	token string,
	threadID string,
	input io.Reader,
	output io.Writer,
	errorOutput io.Writer,
) error {
	if remoteURL == "" || token == "" {
		return errors.New("the secured Codex attach tunnel is incomplete")
	}
	bridge, err := startCodexAttachBridge(ctx, remoteURL)
	if err != nil {
		return err
	}
	defer bridge.stop()
	resume := exec.CommandContext(ctx, binary, codexRemoteResumeArguments(bridge.remoteURL(), threadID)...)
	resume.Stdin, resume.Stdout, resume.Stderr = input, output, errorOutput
	resume.Env = codexRemoteAttachEnvironment(token)
	if err := resume.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Codex remote TUI attachment ended with an error")
	}
	return nil
}

type codexAttachBridge struct {
	cancel   context.CancelFunc
	done     chan struct{}
	listener net.Listener
}

func startCodexAttachBridge(ctx context.Context, remote string) (*codexAttachBridge, error) {
	target, err := url.Parse(remote)
	if err != nil || (target.Scheme != "ws" && target.Scheme != "wss") ||
		target.Host == "" || target.User != nil || target.Fragment != "" {
		return nil, errors.New("the secured Codex attach tunnel URL is invalid")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("create private Codex attach bridge")
	}
	bridgeContext, cancel := context.WithCancel(ctx)
	bridge := &codexAttachBridge{cancel: cancel, done: make(chan struct{}), listener: listener}
	go func() {
		defer close(bridge.done)
		bridge.serve(bridgeContext, target)
	}()
	return bridge, nil
}

func (bridge *codexAttachBridge) remoteURL() string {
	return "ws://" + bridge.listener.Addr().String()
}

func (bridge *codexAttachBridge) serve(ctx context.Context, target *url.URL) {
	client, err := bridge.listener.Accept()
	if err != nil {
		return
	}
	_ = bridge.listener.Close()
	defer client.Close()
	upstream, err := dialCodexAttachTarget(ctx, target)
	if err != nil {
		return
	}
	defer upstream.Close()

	reader := bufio.NewReader(client)
	request, err := http.ReadRequest(reader)
	if err != nil || !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
		return
	}
	request.URL.Scheme = ""
	request.URL.Host = ""
	request.URL.Path = target.Path
	request.URL.RawPath = target.RawPath
	request.URL.RawQuery = target.RawQuery
	request.RequestURI = ""
	request.Host = target.Host
	if err := request.Write(upstream); err != nil {
		return
	}

	relayContext, cancel := context.WithCancel(ctx)
	defer cancel()
	relayDone := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, reader)
		relayDone <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		relayDone <- struct{}{}
	}()
	select {
	case <-relayContext.Done():
	case <-relayDone:
	}
}

func dialCodexAttachTarget(ctx context.Context, target *url.URL) (net.Conn, error) {
	address := target.Host
	if _, _, err := net.SplitHostPort(address); err != nil {
		if target.Scheme == "wss" {
			address = net.JoinHostPort(target.Hostname(), "443")
		} else {
			address = net.JoinHostPort(target.Hostname(), "80")
		}
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	if target.Scheme != "wss" {
		return connection, nil
	}
	secured := tls.Client(connection, &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: target.Hostname(),
	})
	if err := secured.HandshakeContext(ctx); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return secured, nil
}

func (bridge *codexAttachBridge) stop() {
	bridge.cancel()
	_ = bridge.listener.Close()
	select {
	case <-bridge.done:
	case <-time.After(2 * time.Second):
	}
}

func codexRemoteResumeArguments(remoteURL, threadID string) []string {
	return []string{
		"resume", "--remote", remoteURL,
		"--remote-auth-token-env", codexAttachTokenEnvironment,
		threadID,
	}
}

func codexRemoteAttachEnvironment(token string) []string {
	prefix := codexAttachTokenEnvironment + "="
	environment := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, prefix) {
			environment = append(environment, entry)
		}
	}
	return append(environment, prefix+token)
}

func startCodexAppServer(binary, socketPath string, errorOutput io.Writer) (*codexAppServerProcess, error) {
	command := exec.Command(binary, codexAppServerArguments(socketPath)...)
	command.Stdin, command.Stdout, command.Stderr = nil, io.Discard, errorOutput
	command.Env = os.Environ()
	if err := command.Start(); err != nil {
		return nil, errors.New("start Codex App Server")
	}
	process := &codexAppServerProcess{command: command, done: make(chan struct{})}
	go func() {
		_ = command.Wait()
		close(process.done)
	}()
	return process, nil
}

func createPrivateCodexAttachEndpoint() (string, string, error) {
	directory, err := os.MkdirTemp("", "pcx-")
	if err != nil {
		return "", "", errors.New("create private Codex attach directory")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		_ = os.RemoveAll(directory)
		return "", "", errors.New("secure Codex attach directory")
	}
	return directory, filepath.Join(directory, "codex.sock"), nil
}

func codexAppServerArguments(socketPath string) []string {
	return []string{"app-server", "--listen", "unix://" + socketPath}
}

func codexResumeArguments(socketPath, threadID string) []string {
	return []string{"resume", "--remote", "unix://" + socketPath, threadID}
}

func waitForCodexSocket(ctx context.Context, socketPath string, server *codexAppServerProcess) error {
	timeout := time.NewTimer(codexAttachSocketTimeout)
	defer timeout.Stop()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if info, err := os.Lstat(socketPath); err == nil {
			if info.Mode()&os.ModeSocket == 0 {
				return errors.New("Codex App Server created an unsafe non-socket endpoint")
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-server.done:
			return errors.New("Codex App Server exited before its private socket was ready")
		case <-timeout.C:
			return errors.New("Codex App Server did not create its private socket in time")
		case <-ticker.C:
		}
	}
}

func (process *codexAppServerProcess) stop() {
	select {
	case <-process.done:
		return
	default:
	}
	if process.command.Process != nil {
		_ = process.command.Process.Signal(syscall.SIGTERM)
	}
	select {
	case <-process.done:
	case <-time.After(2 * time.Second):
		if process.command.Process != nil {
			_ = process.command.Process.Kill()
		}
		<-process.done
	}
}
