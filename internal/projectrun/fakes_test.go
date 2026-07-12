package projectrun

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"
)

type fakeProcesses struct {
	mutex             sync.Mutex
	nextPID           int
	started           []Command
	stopped           []ProcessRef
	alive             map[int]string
	listeners         map[int]int
	owner             bool
	startErr          error
	foreground        int
	runErr            error
	foregroundWait    bool
	foregroundStarted chan struct{}
	tcpChecks         []int
	tcpOpen           *bool
}

func newFakeProcesses() *fakeProcesses {
	return &fakeProcesses{
		nextPID: 7000, alive: map[int]string{}, listeners: map[int]int{}, owner: true,
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
	if processes.startErr != nil {
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

func (processes *fakeProcesses) OwnsTCP(process ProcessRef, _ string, _ int) (bool, error) {
	if !processes.Alive(process) {
		return false, fmt.Errorf("process identity changed")
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
	processes.stopped = append(processes.stopped, process)
	delete(processes.alive, process.PID)
	for port, listenerPID := range processes.listeners {
		if listenerPID == process.PID {
			delete(processes.listeners, port)
		}
	}
	return nil
}

type fakeTailnet struct {
	ip      string
	routes  map[int]int
	started [][2]int
	stopped [][2]int
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
	waitErrors  map[string]error
	checkErrors map[string]error
	waits       []ProbeTarget
	checks      []ProbeTarget
}

func newFakeProber() *fakeProber {
	return &fakeProber{waitErrors: map[string]error{}, checkErrors: map[string]error{}}
}

func (prober *fakeProber) Wait(_ context.Context, target ProbeTarget, _ time.Duration) error {
	prober.waits = append(prober.waits, target)
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
