package projectrun

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

type fakeProcesses struct {
	mutex             sync.Mutex
	nextPID           int
	started           []Command
	stopped           []ProcessRef
	alive             map[int]string
	listeners         map[int]int
	foreignPorts      map[int]bool
	owner             bool
	startErr          error
	startErrAt        int
	startCalls        int
	stopErr           error
	foreground        int
	runErr            error
	foregroundWait    bool
	foregroundStarted chan struct{}
	tcpChecks         []int
	tcpOpen           *bool
}

type fakeTmux struct {
	mutex     sync.Mutex
	processes *fakeProcesses
	sessions  map[string]TmuxObservation
	created   []TmuxSessionSpec
	stopped   []TmuxSessionSpec
	createErr error
}

func newFakeTmux(processes *fakeProcesses) *fakeTmux {
	return &fakeTmux{processes: processes, sessions: map[string]TmuxObservation{}}
}

func (tmux *fakeTmux) Create(
	_ context.Context,
	spec TmuxSessionSpec,
	command Command,
	_ string,
	_ string,
) (TmuxObservation, error) {
	tmux.mutex.Lock()
	defer tmux.mutex.Unlock()
	if tmux.createErr != nil {
		return TmuxObservation{}, tmux.createErr
	}
	if existing := tmux.sessions[spec.Name]; existing.Exists {
		return existing, fmt.Errorf("session already exists")
	}
	process, err := tmux.processes.StartDetached(command, "", func(ProcessRef) error { return nil })
	if err != nil {
		return TmuxObservation{}, err
	}
	observation := TmuxObservation{Exists: true, Spec: spec, Process: process}
	tmux.sessions[spec.Name] = observation
	tmux.created = append(tmux.created, spec)
	return observation, nil
}

func (tmux *fakeTmux) Inspect(_ context.Context, name string) (TmuxObservation, error) {
	tmux.mutex.Lock()
	defer tmux.mutex.Unlock()
	return tmux.sessions[name], nil
}

func (tmux *fakeTmux) Stop(_ context.Context, spec TmuxSessionSpec) error {
	tmux.mutex.Lock()
	defer tmux.mutex.Unlock()
	observation := tmux.sessions[spec.Name]
	if !observation.Exists {
		return nil
	}
	if !sameTmuxOwnership(observation.Spec, spec) {
		return fmt.Errorf("refusing to stop changed tmux session")
	}
	if err := tmux.processes.StopGroup(observation.Process, time.Second); err != nil {
		return err
	}
	delete(tmux.sessions, spec.Name)
	tmux.stopped = append(tmux.stopped, spec)
	return nil
}

type fakeIdentityResolver struct{}

func (fakeIdentityResolver) Resolve(_ context.Context, directory, serverKey string) (ServerIdentity, error) {
	root, err := canonicalDirectory(directory)
	if err != nil {
		return ServerIdentity{}, err
	}
	return newServerIdentity(filepath.Join(root, ".git"), root, serverKey), nil
}

func newFakeProcesses() *fakeProcesses {
	return &fakeProcesses{
		nextPID: 7000, alive: map[int]string{}, listeners: map[int]int{},
		foreignPorts: map[int]bool{}, owner: true,
	}
}

func (processes *fakeProcesses) RunForeground(
	ctx context.Context,
	command Command,
	streams Streams,
	commit ProcessCommit,
) (int, error) {
	processes.mutex.Lock()
	processes.started = append(processes.started, command)
	processes.nextPID++
	process := ProcessRef{PID: processes.nextPID, Identity: fmt.Sprintf("identity-%d", processes.nextPID)}
	processes.alive[process.PID] = process.Identity
	exitCode, err := processes.foreground, processes.runErr
	wait, started := processes.foregroundWait, processes.foregroundStarted
	processes.mutex.Unlock()
	if commit != nil {
		if commitErr := commit(process); commitErr != nil {
			return -1, commitErr
		}
	}
	if started != nil {
		close(started)
	}
	if wait {
		<-ctx.Done()
		exitCode, err = -1, ctx.Err()
	}
	if streams.Stdout != nil {
		_, _ = io.WriteString(streams.Stdout, "child output\n")
	}
	processes.mutex.Lock()
	delete(processes.alive, process.PID)
	processes.mutex.Unlock()
	return exitCode, err
}

func (processes *fakeProcesses) StartDetached(
	command Command,
	_ string,
	commit ProcessCommit,
) (ProcessRef, error) {
	processes.mutex.Lock()
	defer processes.mutex.Unlock()
	processes.startCalls++
	if processes.startErr != nil || processes.startCalls == processes.startErrAt {
		if processes.startErr == nil {
			return ProcessRef{}, fmt.Errorf("injected process start failure")
		}
		return ProcessRef{}, processes.startErr
	}
	processes.nextPID++
	process := ProcessRef{PID: processes.nextPID, Identity: fmt.Sprintf("identity-%d", processes.nextPID)}
	if err := commit(process); err != nil {
		return ProcessRef{}, err
	}
	processes.alive[process.PID] = process.Identity
	if port, err := strconv.Atoi(environmentMap(command.Env)["PROJECT_PORT"]); err == nil && port > 0 {
		processes.listeners[port] = process.PID
	}
	processes.started = append(processes.started, command)
	return process, nil
}

func (processes *fakeProcesses) Alive(process ProcessRef) bool {
	processes.mutex.Lock()
	defer processes.mutex.Unlock()
	return processes.alive[process.PID] == process.Identity && process.Identity != ""
}

func (processes *fakeProcesses) OwnsTCP(process ProcessRef, _ string, port int) (bool, error) {
	if !processes.Alive(process) {
		return false, fmt.Errorf("process identity changed")
	}
	if processes.foreignPorts[port] {
		return false, nil
	}
	return processes.owner, nil
}

func (processes *fakeProcesses) TCPPortOpen(port int) (bool, error) {
	processes.mutex.Lock()
	defer processes.mutex.Unlock()
	processes.tcpChecks = append(processes.tcpChecks, port)
	if processes.tcpOpen != nil {
		return *processes.tcpOpen, nil
	}
	_, open := processes.listeners[port]
	return open, nil
}

func (processes *fakeProcesses) StopGroup(process ProcessRef, _ time.Duration) error {
	processes.mutex.Lock()
	defer processes.mutex.Unlock()
	identity, exists := processes.alive[process.PID]
	if !exists {
		return nil
	}
	if identity != process.Identity || process.Identity == "" {
		return fmt.Errorf("refusing to stop changed process")
	}
	if processes.stopErr != nil {
		return processes.stopErr
	}
	processes.stopped = append(processes.stopped, process)
	delete(processes.alive, process.PID)
	for port, listenerPID := range processes.listeners {
		if listenerPID == process.PID {
			delete(processes.listeners, port)
		}
	}
	return nil
}

type fakeLocalRouter struct {
	routes    map[string]int
	started   []string
	stopped   []string
	startErr  error
	matchErr  error
	removeErr error
}

func newFakeLocalRouter() *fakeLocalRouter {
	return &fakeLocalRouter{routes: map[string]int{}}
}

func (router *fakeLocalRouter) Register(_ context.Context, name string, port int) (string, error) {
	if router.startErr != nil {
		return "", router.startErr
	}
	if _, exists := router.routes[name]; exists {
		return "", fmt.Errorf("route collision")
	}
	router.routes[name] = port
	router.started = append(router.started, name)
	return "http://" + name + ".localhost:1355", nil
}

func (router *fakeLocalRouter) Matches(
	_ context.Context,
	name string,
	_ string,
	port int,
) (bool, error) {
	if router.matchErr != nil {
		return false, router.matchErr
	}
	return router.routes[name] == port && port > 0, nil
}

func (router *fakeLocalRouter) Remove(
	_ context.Context,
	name string,
	_ string,
	port int,
) error {
	if router.removeErr != nil {
		return router.removeErr
	}
	if current, exists := router.routes[name]; exists && current != port {
		return fmt.Errorf("refusing to remove changed route")
	}
	delete(router.routes, name)
	router.stopped = append(router.stopped, name)
	return nil
}

type fakeTailnet struct {
	ip       string
	routes   map[int]int
	started  [][2]int
	stopped  [][2]int
	startErr error
}

func newFakeTailnet() *fakeTailnet {
	return &fakeTailnet{ip: "100.80.135.9", routes: map[int]int{}}
}

func (tailnet *fakeTailnet) IPv4(context.Context) (string, error) {
	return tailnet.ip, nil
}

func (tailnet *fakeTailnet) OccupiedTCPPorts(context.Context) (map[int]bool, error) {
	result := map[int]bool{}
	for port := range tailnet.routes {
		result[port] = true
	}
	return result, nil
}

func (tailnet *fakeTailnet) MatchesTCP(_ context.Context, publicPort, localPort int) (bool, error) {
	return tailnet.routes[publicPort] == localPort && localPort != 0, nil
}

func (tailnet *fakeTailnet) StartTCP(_ context.Context, publicPort, localPort int) error {
	if tailnet.startErr != nil {
		return tailnet.startErr
	}
	if existing := tailnet.routes[publicPort]; existing != 0 {
		return fmt.Errorf("route collision")
	}
	tailnet.routes[publicPort] = localPort
	tailnet.started = append(tailnet.started, [2]int{publicPort, localPort})
	return nil
}

func (tailnet *fakeTailnet) StopTCP(_ context.Context, publicPort, localPort int) error {
	existing := tailnet.routes[publicPort]
	if existing == 0 {
		return nil
	}
	if existing != localPort {
		return fmt.Errorf("refusing to remove repurposed route")
	}
	delete(tailnet.routes, publicPort)
	tailnet.stopped = append(tailnet.stopped, [2]int{publicPort, localPort})
	return nil
}

type fakeProber struct {
	waitErrors       map[string]error
	waitErrorsByPort map[int][]error
	checkErrors      map[string]error
	waits            []ProbeTarget
	checks           []ProbeTarget
}

func newFakeProber() *fakeProber {
	return &fakeProber{
		waitErrors: map[string]error{}, waitErrorsByPort: map[int][]error{},
		checkErrors: map[string]error{},
	}
}

func (prober *fakeProber) Wait(_ context.Context, target ProbeTarget, _ time.Duration) error {
	prober.waits = append(prober.waits, target)
	if queued := prober.waitErrorsByPort[target.Port]; len(queued) > 0 {
		prober.waitErrorsByPort[target.Port] = queued[1:]
		return queued[0]
	}
	return prober.waitErrors[target.Host]
}

func (prober *fakeProber) Check(_ context.Context, target ProbeTarget) error {
	prober.checks = append(prober.checks, target)
	return prober.checkErrors[target.Host]
}

type fixedPorts struct {
	local  int
	public int
}

type sequencePorts struct {
	local   []int
	public  []int
	localN  int
	publicN int
}

func (ports *sequencePorts) Local(map[int]bool) (int, error) {
	if ports.localN >= len(ports.local) {
		return 0, fmt.Errorf("no local port")
	}
	port := ports.local[ports.localN]
	ports.localN++
	return port, nil
}

func (ports *sequencePorts) Public(map[int]bool) (int, error) {
	if ports.publicN >= len(ports.public) {
		return 0, fmt.Errorf("no public port")
	}
	port := ports.public[ports.publicN]
	ports.publicN++
	return port, nil
}

func (ports fixedPorts) Local(reserved map[int]bool) (int, error) {
	for port := ports.local; port < ports.local+100; port++ {
		if !reserved[port] {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no local port")
}

func (ports fixedPorts) Public(reserved map[int]bool) (int, error) {
	for port := ports.public; port < ports.public+100; port++ {
		if !reserved[port] {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no public port")
}

func newTestManager(t *testing.T) (*Manager, *fakeProcesses, *fakeTailnet, *fakeProber) {
	return newTestManagerWithPorts(t, fixedPorts{local: 43117, public: 44419})
}

func newTestManagerWithPorts(
	t *testing.T,
	ports PortAllocator,
) (*Manager, *fakeProcesses, *fakeTailnet, *fakeProber) {
	t.Helper()
	processes := newFakeProcesses()
	tmux := newFakeTmux(processes)
	tailnet := newFakeTailnet()
	portless := newFakeLocalRouter()
	prober := newFakeProber()
	tokenCounter := 0
	manager, err := NewManager(Dependencies{
		Processes: processes,
		Tmux:      tmux,
		Portless:  portless,
		Tailnet:   tailnet,
		Prober:    prober,
		Ports:     ports,
		StateRoot: filepath.Join(t.TempDir(), "runtime"),
		Now: func() time.Time {
			return time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC)
		},
		Identity: fakeIdentityResolver{},
		Token: func() (string, error) {
			tokenCounter++
			return fmt.Sprintf("token-%d", tokenCounter), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager, processes, tailnet, prober
}

func writeTestScripts(t *testing.T) string {
	t.Helper()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".project"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := "version: 1\nscripts:\n  dev:\n    command: [test-server, --host, \"{host}\", --port, \"{port}\"]\n    healthCheck:\n      path: /health\n      timeoutSeconds: 2\n"
	if err := os.WriteFile(filepath.Join(project, scriptsConfigPath), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return project
}

func assertRunningResult(t *testing.T, result ServeResult) {
	t.Helper()
	if result.SchemaVersion != SchemaVersion || result.Operation != "start" || result.State != StateRunning {
		t.Fatalf("unexpected running result: %#v", result)
	}
	if result.PID == nil || result.LocalPort == nil || *result.LocalPort != 43117 ||
		result.PublicPort == nil || *result.PublicPort != 44419 ||
		result.PublicURL == nil || *result.PublicURL != "http://100.80.135.9:44419" {
		t.Fatalf("running fields = %#v", result)
	}
}

func containsEnvironment(environment []string, value string) bool {
	for _, entry := range environment {
		if entry == value {
			return true
		}
	}
	return false
}

func mustTestIdentity(t *testing.T, manager *Manager, directory, script string) ServerIdentity {
	t.Helper()
	identity, err := manager.identity.Resolve(context.Background(), directory, script)
	if err != nil {
		t.Fatal(err)
	}
	return identity
}
