package projectrun

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"
)

func TestRunOutputKeepsSuccessfulStderrWarningsOutOfStructuredStdout(t *testing.T) {
	output, err := runOutput(
		context.Background(),
		"sh",
		"-c",
		"printf '{\"ok\":true}\\n'; printf 'Warning: diagnostic only\\n' >&2",
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(output) != `{"ok":true}` {
		t.Fatalf("stdout = %q", output)
	}
}

func TestTailscaleCLIStartsVerifiesAndStopsOnlyExactTCPRoute(t *testing.T) {
	runner := newFakeTailscaleCommands()
	tailscale := TailscaleCLI{Run: runner.run}

	if err := tailscale.StartTCP(context.Background(), 44419, 43117); err != nil {
		t.Fatal(err)
	}
	matches, err := tailscale.MatchesTCP(context.Background(), 44419, 43117)
	if err != nil || !matches {
		t.Fatalf("matches=%v error=%v", matches, err)
	}
	if err := tailscale.StopTCP(context.Background(), 44419, 43117); err != nil {
		t.Fatal(err)
	}
	if _, exists := runner.routes[44419]; exists {
		t.Fatal("exact TCP route was not removed")
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "tailscale serve --bg --yes --tcp=44419 tcp://127.0.0.1:43117") {
		t.Fatalf("start command missing: %s", joined)
	}
	if !strings.Contains(joined, "tailscale serve --tcp=44419 off") {
		t.Fatalf("stop command missing: %s", joined)
	}
	if strings.Contains(joined, "reset") {
		t.Fatalf("global reset was called: %s", joined)
	}
}

func TestTailscaleCLIRefusesRepurposedPort(t *testing.T) {
	runner := newFakeTailscaleCommands()
	runner.routes[44419] = 49999
	tailscale := TailscaleCLI{Run: runner.run}

	if err := tailscale.StopTCP(context.Background(), 44419, 43117); err == nil {
		t.Fatal("expected route ownership refusal")
	}
	if runner.routes[44419] != 49999 {
		t.Fatal("repurposed route was removed")
	}
	for _, call := range runner.calls {
		if strings.Contains(call, " off") {
			t.Fatalf("off was called after ownership mismatch: %s", call)
		}
	}
}

func TestTailscaleCLIRefusesToOverwritePreexistingPort(t *testing.T) {
	runner := newFakeTailscaleCommands()
	runner.routes[44419] = 49999
	tailscale := TailscaleCLI{Run: runner.run}

	if err := tailscale.StartTCP(context.Background(), 44419, 43117); err == nil {
		t.Fatal("expected route collision")
	}
	if runner.routes[44419] != 49999 {
		t.Fatal("preexisting route was overwritten")
	}
	for _, call := range runner.calls {
		if strings.Contains(call, " --bg ") {
			t.Fatalf("serve start was called after collision: %s", call)
		}
	}
}

func TestTailscaleCLIRevalidatesPortAfterWaitingForMutationLock(t *testing.T) {
	runner := newFakeTailscaleCommands()
	runner.onStatus = func(statusCall int) {
		if statusCall == 2 {
			runner.routes[44419] = 49999
		}
	}
	tailscale := TailscaleCLI{Run: runner.run}

	if err := tailscale.StartTCP(context.Background(), 44419, 43117); err == nil {
		t.Fatal("expected route collision discovered by locked revalidation")
	}
	if runner.routes[44419] != 49999 {
		t.Fatal("route created during lock acquisition was overwritten")
	}
	for _, call := range runner.calls {
		if strings.Contains(call, " --bg ") {
			t.Fatalf("serve start was called after locked revalidation failed: %s", call)
		}
	}
}

func TestTailscaleCLIRevalidatesExactRouteBeforeStop(t *testing.T) {
	runner := newFakeTailscaleCommands()
	runner.routes[44419] = 43117
	runner.onStatus = func(statusCall int) {
		if statusCall == 2 {
			runner.routes[44419] = 49999
		}
	}
	tailscale := TailscaleCLI{Run: runner.run}

	if err := tailscale.StopTCP(context.Background(), 44419, 43117); err == nil {
		t.Fatal("expected repurposed route discovered by locked revalidation")
	}
	if runner.routes[44419] != 49999 {
		t.Fatal("repurposed route was removed")
	}
	for _, call := range runner.calls {
		if strings.Contains(call, " off") {
			t.Fatalf("off was called after locked revalidation failed: %s", call)
		}
	}
}

func TestTailscaleCLIReportsRouteRepurposedDuringStopWithoutRetrying(t *testing.T) {
	runner := newFakeTailscaleCommands()
	runner.routes[44419] = 43117
	runner.afterStop = func() {
		runner.routes[44419] = 49999
	}
	tailscale := TailscaleCLI{Run: runner.run}

	err := tailscale.StopTCP(context.Background(), 44419, 43117)
	if err == nil || !strings.Contains(err.Error(), "repurposed while stopping") {
		t.Fatalf("stop error = %v", err)
	}
	if runner.routes[44419] != 49999 {
		t.Fatal("route installed during stop verification was removed")
	}
	offCalls := 0
	for _, call := range runner.calls {
		if strings.Contains(call, " off") {
			offCalls++
		}
	}
	if offCalls != 1 {
		t.Fatalf("off calls = %d", offCalls)
	}
}

func TestLimitedOrchestrationOutputIsBounded(t *testing.T) {
	buffer := &limitedBuffer{limit: 8}
	if _, err := buffer.Write([]byte("123456789012345")); err != nil {
		t.Fatal(err)
	}
	if got := string(buffer.Bytes()); got != "12345678\n[output truncated]" {
		t.Fatalf("output = %q", got)
	}
}

type fakeTailscaleCommands struct {
	routes      map[int]int
	calls       []string
	statusCalls int
	onStatus    func(int)
	afterStop   func()
}

func newFakeTailscaleCommands() *fakeTailscaleCommands {
	return &fakeTailscaleCommands{routes: map[int]int{}}
}

func (runner *fakeTailscaleCommands) run(_ context.Context, name string, args ...string) (string, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	runner.calls = append(runner.calls, call)
	if call == "tailscale ip -4" {
		return "100.80.135.9\n", nil
	}
	if call == "tailscale serve status --json" {
		runner.statusCalls++
		if runner.onStatus != nil {
			runner.onStatus(runner.statusCalls)
		}
		payload := struct {
			TCP map[string]tcpRoute `json:"TCP"`
		}{TCP: map[string]tcpRoute{}}
		for publicPort, localPort := range runner.routes {
			payload.TCP[strconv.Itoa(publicPort)] = tcpRoute{TCPForward: tcpTarget(localPort)}
		}
		body, _ := json.Marshal(payload)
		return string(body), nil
	}
	if len(args) == 5 && args[0] == "serve" && args[1] == "--bg" && args[2] == "--yes" {
		publicPort, err := parseTCPFlag(args[3])
		if err != nil {
			return "", err
		}
		localValue := strings.TrimPrefix(args[4], "tcp://127.0.0.1:")
		localPort, err := strconv.Atoi(localValue)
		if err != nil {
			return "", err
		}
		runner.routes[publicPort] = localPort
		return "started", nil
	}
	if len(args) == 3 && args[0] == "serve" && args[2] == "off" {
		publicPort, err := parseTCPFlag(args[1])
		if err != nil {
			return "", err
		}
		delete(runner.routes, publicPort)
		if runner.afterStop != nil {
			runner.afterStop()
		}
		return "stopped", nil
	}
	return "", fmt.Errorf("unexpected command: %s", call)
}

func parseTCPFlag(value string) (int, error) {
	return strconv.Atoi(strings.TrimPrefix(value, "--tcp="))
}
