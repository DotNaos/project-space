package clientaccess

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/DotNaos/project-space/internal/computeinventory"
)

type FailurePhase string

const (
	PhaseLocalClient FailurePhase = "local_client"
	PhaseTailnet     FailurePhase = "tailnet"
	PhaseTarget      FailurePhase = "target"
	PhaseSSH         FailurePhase = "ssh"
	PhaseHostKey     FailurePhase = "host_key"
	PhaseCodex       FailurePhase = "codex"
)

type FailureCode string

const (
	CodeLocalClientUnavailable FailureCode = "local_client_unavailable"
	CodeTailnetUnavailable     FailureCode = "tailnet_unavailable"
	CodeTargetUnavailable      FailureCode = "target_unavailable"
	CodeSSHUnavailable         FailureCode = "ssh_unavailable"
	CodeHostKeyMismatch        FailureCode = "host_key_mismatch"
	CodeAuthenticationFailed   FailureCode = "authentication_failed"
	CodeCodexUnavailable       FailureCode = "codex_unavailable"
)

type Failure struct {
	Phase   FailurePhase
	Code    FailureCode
	Message string
}

func (failure *Failure) Error() string {
	return fmt.Sprintf("%s: %s", failure.Code, failure.Message)
}

type Target struct {
	Address                string
	HostKeySHA256          string
	Port                   int
	TargetIdentityRevision string
	User                   string
}

type CommandRunner func(context.Context, string, []string, []byte) (stdout, stderr string, err error)
type InteractiveRunner func(context.Context, io.Reader, io.Writer, io.Writer, string, []string) error
type LookPath func(string) (string, error)

type Dependencies struct {
	Interactive InteractiveRunner
	LookPath    LookPath
	Run         CommandRunner
}

func DefaultDependencies() Dependencies {
	return Dependencies{
		Interactive: runInteractive,
		LookPath:    exec.LookPath,
		Run:         runCommand,
	}
}

func TargetFromRoute(route computeinventory.AccessRoute) (Target, error) {
	if route.Type != "ssh_private_network" || route.ProviderKind != "tailscale" ||
		route.State != "ready" || route.ClientAccess == nil {
		return Target{}, &Failure{
			Phase: PhaseTarget, Code: CodeTargetUnavailable,
			Message: "the Environment has no fresh, verified Tailscale SSH route",
		}
	}
	access := route.ClientAccess
	if !isTailscaleIPv4(access.Address) || access.Port < 1 || access.Port > 65535 ||
		access.User == "" || access.HostKeySHA256 == "" || access.TargetIdentityRevision == "" {
		return Target{}, &Failure{
			Phase: PhaseTarget, Code: CodeTargetUnavailable,
			Message: "the Environment access metadata is incomplete or not a Tailscale IPv4 target",
		}
	}
	return Target{
		Address: access.Address, HostKeySHA256: access.HostKeySHA256,
		Port: access.Port, TargetIdentityRevision: access.TargetIdentityRevision,
		User: access.User,
	}, nil
}

func Open(ctx context.Context, target Target, input io.Reader, output, errorOutput io.Writer, dependencies Dependencies) error {
	if dependencies.LookPath == nil || dependencies.Run == nil || dependencies.Interactive == nil {
		return &Failure{Phase: PhaseLocalClient, Code: CodeLocalClientUnavailable, Message: "the local SSH bridge is not configured"}
	}
	if !isTailscaleIPv4(target.Address) || target.Port < 1 || target.Port > 65535 ||
		target.User == "" || target.HostKeySHA256 == "" || target.TargetIdentityRevision == "" {
		return &Failure{Phase: PhaseTarget, Code: CodeTargetUnavailable, Message: "the client-owned SSH target is invalid"}
	}
	if _, err := dependencies.LookPath("tailscale"); err != nil {
		return &Failure{Phase: PhaseLocalClient, Code: CodeLocalClientUnavailable, Message: "Tailscale is not installed on this client"}
	}
	if _, err := dependencies.LookPath("ssh-keyscan"); err != nil {
		return &Failure{Phase: PhaseSSH, Code: CodeSSHUnavailable, Message: "ssh-keyscan is not available on this client"}
	}
	sshBinary, err := dependencies.LookPath("ssh")
	if err != nil {
		return &Failure{Phase: PhaseSSH, Code: CodeSSHUnavailable, Message: "ssh is not available on this client"}
	}
	if err := verifyTailnet(ctx, dependencies); err != nil {
		return err
	}
	keyscan, stderr, err := dependencies.Run(ctx, "ssh-keyscan", []string{"-4", "-p", strconv.Itoa(target.Port), target.Address}, nil)
	if err != nil {
		return &Failure{Phase: PhaseSSH, Code: CodeSSHUnavailable, Message: commandFailure(stderr, "the client could not inspect the target SSH service")}
	}
	keyLine, ok := matchingHostKey(keyscan, target.HostKeySHA256)
	if !ok {
		return &Failure{Phase: PhaseHostKey, Code: CodeHostKeyMismatch, Message: "the target SSH host key does not match the verified Environment identity"}
	}
	knownHosts, err := os.CreateTemp("", "project-space-known-hosts-")
	if err != nil {
		return &Failure{Phase: PhaseLocalClient, Code: CodeLocalClientUnavailable, Message: "the client could not create a private host-key file"}
	}
	knownHostsPath := filepath.Clean(knownHosts.Name())
	defer os.Remove(knownHostsPath)
	if err := knownHosts.Chmod(0o600); err != nil {
		_ = knownHosts.Close()
		return &Failure{Phase: PhaseLocalClient, Code: CodeLocalClientUnavailable, Message: "the client could not protect the temporary host-key file"}
	}
	if _, err := knownHosts.WriteString(keyLine + "\n"); err != nil {
		_ = knownHosts.Close()
		return &Failure{Phase: PhaseLocalClient, Code: CodeLocalClientUnavailable, Message: "the client could not prepare host-key verification"}
	}
	if err := knownHosts.Close(); err != nil {
		return &Failure{Phase: PhaseLocalClient, Code: CodeLocalClientUnavailable, Message: "the client could not finalize host-key verification"}
	}
	args := []string{
		"-4", "-p", strconv.Itoa(target.Port),
		"-o", "BatchMode=no",
		"-o", "GlobalKnownHostsFile=" + os.DevNull,
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=" + knownHostsPath,
		target.User + "@" + target.Address,
	}
	var transcript bytes.Buffer
	interactiveError := dependencies.Interactive(ctx, input, output, io.MultiWriter(errorOutput, &transcript), sshBinary, args)
	if interactiveError == nil {
		return nil
	}
	return classifySSHFailure(interactiveError, transcript.String())
}

func verifyTailnet(ctx context.Context, dependencies Dependencies) error {
	stdout, stderr, err := dependencies.Run(ctx, "tailscale", []string{"status", "--json"}, nil)
	if err != nil {
		return &Failure{Phase: PhaseTailnet, Code: CodeTailnetUnavailable, Message: commandFailure(stderr, "Tailscale status could not be read")}
	}
	var status struct {
		BackendState string `json:"BackendState"`
		Self         struct {
			TailscaleIPs []string `json:"TailscaleIPs"`
		} `json:"Self"`
	}
	if err := json.Unmarshal([]byte(stdout), &status); err != nil || status.BackendState != "Running" ||
		!hasTailscaleIPv4(status.Self.TailscaleIPs) {
		return &Failure{Phase: PhaseTailnet, Code: CodeTailnetUnavailable, Message: "Tailscale is not online on this client"}
	}
	return nil
}

func matchingHostKey(output, expected string) (string, bool) {
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(fields[2])
		if err != nil {
			continue
		}
		digest := sha256.Sum256(decoded)
		fingerprint := "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:])
		if fingerprint == expected {
			return strings.Join(fields[:3], " "), true
		}
	}
	return "", false
}

func classifySSHFailure(commandError error, transcript string) *Failure {
	message := strings.ToLower(commandError.Error() + " " + transcript)
	switch {
	case strings.Contains(message, "permission denied"), strings.Contains(message, "authentication"), strings.Contains(message, "publickey"):
		return &Failure{Phase: PhaseSSH, Code: CodeAuthenticationFailed, Message: "SSH authentication failed on the client"}
	case strings.Contains(message, "no route"), strings.Contains(message, "timed out"), strings.Contains(message, "connection refused"), strings.Contains(message, "network is unreachable"):
		return &Failure{Phase: PhaseTarget, Code: CodeTargetUnavailable, Message: "the Tailscale target could not be reached by the client"}
	default:
		return &Failure{Phase: PhaseSSH, Code: CodeSSHUnavailable, Message: "the client SSH session ended before it became usable"}
	}
}

func commandFailure(stderr, fallback string) string {
	if message := strings.TrimSpace(stderr); message != "" {
		return message
	}
	return fallback
}

func isTailscaleIPv4(value string) bool {
	ip := net.ParseIP(value)
	if ip == nil || ip.To4() == nil {
		return false
	}
	octets := ip.To4()
	return octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127
}

func hasTailscaleIPv4(values []string) bool {
	for _, value := range values {
		if isTailscaleIPv4(value) {
			return true
		}
	}
	return false
}

func runCommand(ctx context.Context, name string, args []string, stdin []byte) (string, string, error) {
	command := exec.CommandContext(ctx, name, args...)
	if stdin != nil {
		command.Stdin = bytes.NewReader(stdin)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	stdout, err := command.Output()
	return string(stdout), stderr.String(), err
}

func runInteractive(ctx context.Context, input io.Reader, output, errorOutput io.Writer, name string, args []string) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdin, command.Stdout, command.Stderr = input, output, errorOutput
	return command.Run()
}
