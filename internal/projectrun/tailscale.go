package projectrun

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

const maxOrchestrationOutput = 64 << 10

var tailscaleMutationMutex sync.Mutex

type TailscaleCLI struct {
	Run func(context.Context, string, ...string) (string, error)
}

func (tailscale TailscaleCLI) IPv4(ctx context.Context) (string, error) {
	output, err := tailscale.output(ctx, "tailscale", "ip", "-4")
	if err != nil {
		return "", fmt.Errorf("read Tailscale IPv4: %w", err)
	}
	address := strings.TrimSpace(output)
	parsed := net.ParseIP(address)
	if parsed == nil || parsed.To4() == nil {
		return "", fmt.Errorf("tailscale ip -4 returned %q, not one IPv4 address", address)
	}
	return parsed.String(), nil
}

func (tailscale TailscaleCLI) OccupiedTCPPorts(ctx context.Context) (map[int]bool, error) {
	routes, err := tailscale.readTCPRoutes(ctx)
	if err != nil {
		return nil, err
	}
	ports := make(map[int]bool, len(routes))
	for value := range routes {
		port, err := strconv.Atoi(value)
		if err == nil && port > 0 && port <= 65535 {
			ports[port] = true
		}
	}
	return ports, nil
}

func (tailscale TailscaleCLI) MatchesTCP(ctx context.Context, publicPort, localPort int) (bool, error) {
	target, exists, err := tailscale.currentTCPRoute(ctx, publicPort)
	if err != nil {
		return false, err
	}
	return exists && target == tcpTarget(localPort), nil
}

func (tailscale TailscaleCLI) StartTCP(ctx context.Context, publicPort, localPort int) error {
	target, exists, err := tailscale.currentTCPRoute(ctx, publicPort)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("Tailscale TCP port %d is already routed to %q", publicPort, target)
	}
	tailscaleMutationMutex.Lock()
	defer tailscaleMutationMutex.Unlock()
	target, exists, err = tailscale.currentTCPRoute(ctx, publicPort)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf(
			"refusing to overwrite Tailscale TCP port %d: it became routed to %q before start",
			publicPort, target,
		)
	}
	if _, err := tailscale.output(
		ctx,
		"tailscale", "serve", "--bg", "--yes",
		fmt.Sprintf("--tcp=%d", publicPort), "tcp://"+tcpTarget(localPort),
	); err != nil {
		return fmt.Errorf("start Tailscale TCP forwarder: %w", err)
	}
	target, exists, err = tailscale.currentTCPRoute(ctx, publicPort)
	if err != nil {
		return err
	}
	expected := tcpTarget(localPort)
	if !exists {
		return fmt.Errorf("Tailscale TCP port %d did not retain the expected route %q", publicPort, expected)
	}
	if target != expected {
		return fmt.Errorf(
			"Tailscale TCP port %d changed during start: expected %q, found %q",
			publicPort, expected, target,
		)
	}
	return nil
}

func (tailscale TailscaleCLI) StopTCP(ctx context.Context, publicPort, localPort int) error {
	target, exists, err := tailscale.currentTCPRoute(ctx, publicPort)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	expected := tcpTarget(localPort)
	if target != expected {
		return fmt.Errorf(
			"refusing to remove Tailscale TCP port %d: expected %q, found %q",
			publicPort, expected, target,
		)
	}
	tailscaleMutationMutex.Lock()
	defer tailscaleMutationMutex.Unlock()
	target, exists, err = tailscale.currentTCPRoute(ctx, publicPort)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if target != expected {
		return fmt.Errorf(
			"refusing to remove Tailscale TCP port %d: route changed before stop; expected %q, found %q",
			publicPort, expected, target,
		)
	}
	if _, err := tailscale.output(ctx, "tailscale", "serve", fmt.Sprintf("--tcp=%d", publicPort), "off"); err != nil {
		return fmt.Errorf("remove Tailscale TCP port %d: %w", publicPort, err)
	}
	target, stillExists, err := tailscale.currentTCPRoute(ctx, publicPort)
	if err != nil {
		return err
	}
	if stillExists {
		if target == expected {
			return fmt.Errorf("Tailscale TCP port %d is still configured after stop", publicPort)
		}
		return fmt.Errorf(
			"Tailscale TCP port %d was repurposed while stopping; current route %q was left in place",
			publicPort, target,
		)
	}
	return nil
}

type tcpRoute struct {
	TCPForward string `json:"TCPForward"`
}

func (tailscale TailscaleCLI) readTCPRoutes(ctx context.Context) (map[string]tcpRoute, error) {
	output, err := tailscale.output(ctx, "tailscale", "serve", "status", "--json")
	if err != nil {
		return nil, fmt.Errorf("read Tailscale Serve status: %w", err)
	}
	payload := struct {
		TCP map[string]tcpRoute `json:"TCP"`
	}{}
	if err := json.Unmarshal([]byte(output), &payload); err != nil {
		return nil, fmt.Errorf("parse Tailscale Serve status: %w", err)
	}
	if payload.TCP == nil {
		payload.TCP = map[string]tcpRoute{}
	}
	return payload.TCP, nil
}

func (tailscale TailscaleCLI) currentTCPRoute(ctx context.Context, publicPort int) (string, bool, error) {
	routes, err := tailscale.readTCPRoutes(ctx)
	if err != nil {
		return "", false, err
	}
	route, exists := routes[strconv.Itoa(publicPort)]
	if !exists {
		return "", false, nil
	}
	return route.TCPForward, true, nil
}

func tcpTarget(localPort int) string {
	return "127.0.0.1:" + strconv.Itoa(localPort)
}

func (tailscale TailscaleCLI) output(ctx context.Context, name string, args ...string) (string, error) {
	if tailscale.Run != nil {
		return tailscale.Run(ctx, name, args...)
	}
	return runOutput(ctx, name, args...)
}

func runOutput(ctx context.Context, name string, args ...string) (string, error) {
	executable, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("find %q: %w", name, err)
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Env = safeEnvironment(os.Environ())
	stdout := &limitedBuffer{limit: maxOrchestrationOutput}
	stderr := &limitedBuffer{limit: maxOrchestrationOutput}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err = cmd.Run()
	if err != nil {
		message := strings.TrimSpace(strings.Join([]string{
			strings.TrimSpace(string(stdout.Bytes())),
			strings.TrimSpace(string(stderr.Bytes())),
		}, "\n"))
		if message == "" {
			return "", err
		}
		return "", fmt.Errorf("%w: %s", err, message)
	}
	return string(stdout.Bytes()), nil
}

type limitedBuffer struct {
	mutex     sync.Mutex
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (buffer *limitedBuffer) Write(value []byte) (int, error) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	written := len(value)
	remaining := buffer.limit - buffer.buffer.Len()
	if remaining <= 0 {
		buffer.truncated = true
		return written, nil
	}
	if len(value) > remaining {
		value = value[:remaining]
		buffer.truncated = true
	}
	_, _ = buffer.buffer.Write(value)
	return written, nil
}

func (buffer *limitedBuffer) Bytes() []byte {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	result := append([]byte{}, buffer.buffer.Bytes()...)
	if buffer.truncated {
		result = append(result, []byte("\n[output truncated]")...)
	}
	return result
}
