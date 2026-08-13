package projectrun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestServeLifecycleIsIdempotentAndExact(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	portless := manager.portless.(*fakeLocalRouter)

	started, err := manager.Start(context.Background(), project, "dev", []string{
		"Preview.Example.com", "app.example.com", "preview.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	assertRunningResult(t, started)
	if started.LocalURL == nil || !strings.HasSuffix(*started.LocalURL, ".localhost:1355") ||
		started.PortlessName == "" || portless.routes[started.PortlessName] != 43117 {
		t.Fatalf("Portless route = %#v routes=%#v", started, portless.routes)
	}
	if !reflect.DeepEqual(started.AllowedHosts, []string{"app.example.com", "preview.example.com"}) {
		t.Fatalf("allowed hosts = %#v", started.AllowedHosts)
	}
	command := processes.started[0]
	if command.InheritEnv {
		t.Fatal("managed command unexpectedly inherits the connector environment")
	}
	if got := strings.Join(command.Argv, " "); got != "test-server --host 127.0.0.1 --port 43117" {
		t.Fatalf("command = %q", got)
	}
	if !containsEnvironment(command.Env, "PROJECT_ALLOWED_HOSTS=app.example.com,preview.example.com") ||
		!containsEnvironment(command.Env, "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=") ||
		!containsEnvironment(command.Env, "PROJECT_SPACE_MANAGED_SERVE=1") ||
		!containsEnvironment(command.Env, "PROJECT_SPACE_SERVE_MODE=managed") ||
		!containsEnvironment(command.Env, "PROJECT_SPACE_RUNTIME_ACCESS_URL="+*started.PublicURL) ||
		!containsEnvironment(command.Env, "PORTLESS_URL="+*started.LocalURL) {
		t.Fatalf("managed environment = %#v", command.Env)
	}

	again, err := manager.Start(context.Background(), project, "dev", []string{
		"preview.example.com", "app.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	assertRunningResult(t, again)
	if len(processes.started) != 1 || len(tailnet.started) != 1 || len(portless.started) != 1 {
		t.Fatalf("idempotent start launched again: processes=%d routes=%d", len(processes.started), len(tailnet.started))
	}

	status, err := manager.Status(context.Background(), project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if status.Operation != "status" || status.State != StateRunning {
		t.Fatalf("unexpected status: %#v", status)
	}

	if _, err := manager.Start(context.Background(), project, "dev", []string{"other.example.com"}); err == nil {
		t.Fatal("expected changed allowed hosts to require an explicit stop")
	}
	stopped, err := manager.Stop(context.Background(), project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if stopped.State != StateStopped || stopped.PublicURL != nil || stopped.PID != nil {
		t.Fatalf("unexpected stop result: %#v", stopped)
	}
	if !reflect.DeepEqual(tailnet.stopped, [][2]int{{44419, 43117}}) {
		t.Fatalf("stopped routes = %#v", tailnet.stopped)
	}
	if len(processes.stopped) != 1 {
		t.Fatalf("stopped process groups = %d", len(processes.stopped))
	}
	if len(portless.routes) != 0 || len(portless.stopped) != 1 {
		t.Fatalf("Portless route was not removed exactly once: routes=%#v stopped=%#v", portless.routes, portless.stopped)
	}

	if _, err := manager.Stop(context.Background(), project, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(tailnet.stopped) != 1 || len(processes.stopped) != 1 || len(portless.stopped) != 1 {
		t.Fatal("idempotent stop touched the runtime again")
	}
}

func TestSingleAllowedHostUsesViteCompatibilityVariable(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, _, _ := newTestManager(t)
	if _, err := manager.Start(context.Background(), project, "dev", []string{"preview.example.com"}); err != nil {
		t.Fatal(err)
	}
	command := processes.started[0]
	if !containsEnvironment(command.Env, "PROJECT_ALLOWED_HOSTS=preview.example.com") ||
		!containsEnvironment(command.Env, "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=preview.example.com") {
		t.Fatalf("managed environment = %#v", command.Env)
	}
}

func TestWorkspaceOwnedServeSessionRequiresExactRuntimeBindingToStop(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, _, _ := newTestManager(t)
	const workspaceID = "ws_0123456789abcdef01234567"
	const generation = "123e4567-e89b-42d3-a456-426614174000"
	started, err := manager.StartWithOptions(context.Background(), project, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal,
		WorkspaceID: workspaceID, RuntimeGeneration: generation,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Stop(context.Background(), project, "dev"); err == nil {
		t.Fatal("ordinary serve stop reached a Workspace-owned session")
	}
	if len(processes.stopped) != 0 {
		t.Fatal("ordinary serve stop mutated a Workspace-owned process")
	}
	if _, err := manager.StopExpected(context.Background(), project, "dev", workspaceID, generation); err != nil {
		t.Fatalf("exact Workspace stop: %v", err)
	}
	if len(processes.stopped) != 1 || started.WorkspaceID != workspaceID || started.RuntimeGeneration != generation {
		t.Fatalf("exact Workspace stop evidence = %#v, stopped=%d", started, len(processes.stopped))
	}
}

func TestStatusCleansRuntimeWhenScriptsConfigDisappears(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	if _, err := manager.Start(context.Background(), project, "dev", nil); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(project, scriptsConfigPath)); err != nil {
		t.Fatal(err)
	}

	status, err := manager.Status(context.Background(), project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != StateStopped || status.Capability != CapabilityUnavailable ||
		status.PID != nil || status.PublicURL != nil || status.LastError == nil {
		t.Fatalf("status = %#v", status)
	}
	if len(processes.stopped) != 1 || len(tailnet.stopped) != 1 || len(tailnet.routes) != 0 {
		t.Fatalf("runtime was not cleaned: processes=%#v routes=%#v", processes.stopped, tailnet.routes)
	}
	if _, ok, loadErr := manager.store.load(mustTestIdentity(t, manager, project, "dev")); loadErr != nil || ok {
		t.Fatalf("stale state remains: ok=%v err=%v", ok, loadErr)
	}
}

func TestStopCleansRuntimeAfterProjectDirectoryIsDeleted(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	if _, err := manager.Start(context.Background(), project, "dev", nil); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(project); err != nil {
		t.Fatal(err)
	}

	stopped, err := manager.Stop(context.Background(), project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if stopped.State != StateStopped || stopped.Capability != CapabilityUnavailable ||
		stopped.PID != nil || stopped.PublicURL != nil {
		t.Fatalf("stop = %#v", stopped)
	}
	if len(processes.stopped) != 1 || len(tailnet.stopped) != 1 || len(tailnet.routes) != 0 {
		t.Fatalf("runtime was not cleaned: processes=%#v routes=%#v", processes.stopped, tailnet.routes)
	}
	if _, err := manager.Stop(context.Background(), project, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(processes.stopped) != 1 || len(tailnet.stopped) != 1 {
		t.Fatal("idempotent stop touched the deleted runtime again")
	}
}

func TestStopFindsCanonicalStateAfterRequestedSymlinkIsDeleted(t *testing.T) {
	project := writeTestScripts(t)
	alias := filepath.Join(t.TempDir(), "project-link")
	if err := os.Symlink(project, alias); err != nil {
		t.Fatal(err)
	}
	manager, processes, tailnet, _ := newTestManager(t)
	if _, err := manager.Start(context.Background(), alias, "dev", nil); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}

	stopped, err := manager.Stop(context.Background(), alias, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if stopped.State != StateStopped || stopped.Capability != CapabilityConfigured {
		t.Fatalf("stop = %#v", stopped)
	}
	if len(processes.stopped) != 1 || len(tailnet.stopped) != 1 || len(tailnet.routes) != 0 {
		t.Fatalf("runtime was not cleaned: processes=%#v routes=%#v", processes.stopped, tailnet.routes)
	}
}

func TestReconcileKeepsHealthySessionsAndRemovesUnavailableOnes(t *testing.T) {
	healthyProject := writeTestScripts(t)
	removedProject := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	if _, err := manager.Start(context.Background(), healthyProject, "dev", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), removedProject, "dev", nil); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(removedProject, scriptsConfigPath)); err != nil {
		t.Fatal(err)
	}

	result, err := manager.Reconcile(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Operation != "reconcile" || result.ErrorCount != 0 || len(result.Sessions) != 2 {
		t.Fatalf("reconcile = %#v", result)
	}
	states := map[string]ServeResult{}
	for _, session := range result.Sessions {
		states[session.Directory] = session
	}
	healthyRoot, err := canonicalDirectory(healthyProject)
	if err != nil {
		t.Fatal(err)
	}
	removedRoot, err := canonicalDirectory(removedProject)
	if err != nil {
		t.Fatal(err)
	}
	if states[healthyRoot].State != StateRunning || states[healthyRoot].Capability != CapabilityConfigured {
		t.Fatalf("healthy session = %#v", states[healthyRoot])
	}
	if states[removedRoot].State != StateStopped || states[removedRoot].Capability != CapabilityUnavailable ||
		states[removedRoot].LastError == nil {
		t.Fatalf("removed session = %#v", states[removedRoot])
	}
	if len(processes.stopped) != 1 || len(tailnet.routes) != 1 {
		t.Fatalf("reconcile cleanup = processes=%#v routes=%#v", processes.stopped, tailnet.routes)
	}
}

func TestConcurrentStartUsesOneSessionAndOnePortReservation(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	results := make(chan ServeResult, 2)
	errors := make(chan error, 2)
	start := make(chan struct{})
	wait := sync.WaitGroup{}
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := manager.Start(context.Background(), project, "dev", nil)
			results <- result
			errors <- err
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	for result := range results {
		if result.State != StateRunning || result.PublicPort == nil || *result.PublicPort != 44419 {
			t.Fatalf("concurrent result = %#v", result)
		}
	}
	if len(processes.started) != 1 || len(tailnet.started) != 1 {
		t.Fatalf("concurrent start duplicated resources: processes=%d routes=%d", len(processes.started), len(tailnet.started))
	}
}

func TestLocalOnlyRequiresExplicitModeAndNeverPublishesTailnet(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)

	started, err := manager.StartWithOptions(context.Background(), project, "dev", StartOptions{LocalOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if started.State != StateLocalOnly || started.Mode != ServeModeLocalOnly || started.PublicURL != nil ||
		started.PublicPort != nil || started.TailscaleIPv4 != nil {
		t.Fatalf("local-only result = %#v", started)
	}
	if len(tailnet.started) != 0 || len(tailnet.routes) != 0 {
		t.Fatalf("local-only start touched Tailscale: %#v %#v", tailnet.started, tailnet.routes)
	}
	if len(processes.started) != 1 || !containsEnvironment(
		processes.started[0].Env, "PROJECT_SPACE_SERVE_MODE=local-only",
	) || !containsEnvironment(processes.started[0].Env, "PROJECT_SPACE_RUNTIME_ACCESS_URL="+*started.LocalURL) {
		t.Fatalf("local-only command = %#v", processes.started)
	}
	stopped, err := manager.Stop(context.Background(), project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if stopped.State != StateStopped || stopped.Mode != ServeModeLocalOnly || stopped.TmuxSession == "" {
		t.Fatalf("stopped local-only result = %#v", stopped)
	}
	started, err = manager.StartWithOptions(context.Background(), project, "dev", StartOptions{LocalOnly: true})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := manager.Start(context.Background(), project, "dev", nil); err == nil ||
		!strings.Contains(err.Error(), "already running in local-only mode") {
		t.Fatalf("managed mode mismatch error = %v", err)
	}
}

func TestPublishExpectedReplacesOnlyExactOwnedLocalGeneration(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	workspaceID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	runtimeGeneration := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	started, err := manager.StartWithOptions(context.Background(), project, "dev", StartOptions{
		LocalOnly: true, WorkspaceID: workspaceID, RuntimeGeneration: runtimeGeneration,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PublishExpected(context.Background(), project, "dev", workspaceID,
		runtimeGeneration, "wrong-generation", nil); err == nil {
		t.Fatal("wrong server generation was published")
	}
	if len(processes.stopped) != 0 || len(tailnet.routes) != 0 {
		t.Fatalf("wrong generation mutated resources: stopped=%#v routes=%#v", processes.stopped, tailnet.routes)
	}
	published, err := manager.PublishExpected(context.Background(), project, "dev", workspaceID,
		runtimeGeneration, started.ServerGeneration, nil)
	if err != nil {
		t.Fatal(err)
	}
	if published.Operation != "publish" || published.State != StateRunning ||
		published.Mode != ServeModeManaged || published.ServerGeneration == started.ServerGeneration ||
		published.PublicPort == nil || tailnet.routes[*published.PublicPort] != *published.LocalPort {
		t.Fatalf("published result = %#v routes=%#v", published, tailnet.routes)
	}
	replayed, err := manager.PublishExpected(context.Background(), project, "dev", workspaceID,
		runtimeGeneration, published.ServerGeneration, nil)
	if err != nil || replayed.Disposition != ServeDispositionReused || replayed.ServerGeneration != published.ServerGeneration {
		t.Fatalf("publish replay = %#v err=%v", replayed, err)
	}
}

func TestExternalBindingsFailBeforeStartingProcessesOrTailnet(t *testing.T) {
	project := writeTestScripts(t)
	for _, data := range []DataMode{DataModeLocal, DataModeRemote} {
		t.Run(string(data), func(t *testing.T) {
			manager, processes, tailnet, _ := newTestManager(t)
			result, err := manager.StartWithOptions(context.Background(), project, "dev", StartOptions{
				APIs: APIsModeExternal,
				Data: data,
			})
			if err == nil || !strings.Contains(err.Error(), "service-account delivery") {
				t.Fatalf("external start error = %v", err)
			}
			if result.State != StateFailed || len(processes.started) != 0 || len(tailnet.started) != 0 {
				t.Fatalf("external start touched runtime: result=%#v processes=%d tailnet=%d", result, len(processes.started), len(tailnet.started))
			}
		})
	}
}

func TestTailscaleStartFailureCompensatesOwnedTmuxWithoutLocalOnlyFallback(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	tailnet.startErr = errors.New("Tailscale publication failed")

	result, err := manager.Start(context.Background(), project, "dev", nil)
	if err == nil || !strings.Contains(err.Error(), "Tailscale publication failed") {
		t.Fatalf("start error = %v", err)
	}
	if result.State != StateFailed || result.Mode != ServeModeManaged || result.PublicURL != nil ||
		result.State == StateLocalOnly {
		t.Fatalf("failed managed result = %#v", result)
	}
	if len(processes.stopped) != 1 || len(tailnet.routes) != 0 {
		t.Fatalf("compensation = stopped %#v routes %#v", processes.stopped, tailnet.routes)
	}
}

func TestStopRefusesChangedTmuxOwnershipBeforeMutatingRoute(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	started, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	tmux := manager.tmux.(*fakeTmux)
	observation := tmux.sessions[started.TmuxSession]
	observation.Spec.OwnershipToken = "foreign-generation"
	tmux.sessions[started.TmuxSession] = observation

	result, err := manager.Stop(context.Background(), project, "dev")
	if err == nil || !strings.Contains(err.Error(), "ownership changed") {
		t.Fatalf("stop error = %v", err)
	}
	if result.State != StateFailed || len(processes.stopped) != 0 || len(tailnet.stopped) != 0 ||
		tailnet.routes[*started.PublicPort] != *started.LocalPort {
		t.Fatalf("foreign tmux resources were mutated: result=%#v stopped=%#v routes=%#v", result, processes.stopped, tailnet.routes)
	}
}

func TestListRevalidatesRuntimeAndLeavesForeignOwnershipUntouched(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	started, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	tmux := manager.tmux.(*fakeTmux)
	observation := tmux.sessions[started.TmuxSession]
	observation.Spec.OwnershipToken = "foreign-generation"
	tmux.sessions[started.TmuxSession] = observation

	result, err := manager.ListSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].State != StateFailed ||
		result.Sessions[0].LastError == nil {
		t.Fatalf("runtime list = %#v", result)
	}
	if len(processes.stopped) != 0 || len(tailnet.stopped) != 0 ||
		tailnet.routes[*started.PublicPort] != *started.LocalPort {
		t.Fatalf("runtime list mutated foreign ownership: %#v %#v", processes.stopped, tailnet.stopped)
	}
}

func TestObserveSessionsNeverRunsHealthChecksOrCleanup(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	started, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	tmux := manager.tmux.(*fakeTmux)
	observation := tmux.sessions[started.TmuxSession]
	observation.Spec.OwnershipToken = "foreign-generation"
	tmux.sessions[started.TmuxSession] = observation

	result, err := manager.ObserveSessions(context.Background())
	if err != nil || len(result.Sessions) != 1 || result.Sessions[0].State != StateRunning {
		t.Fatalf("read-only observation = %#v, %v", result, err)
	}
	if len(processes.stopped) != 0 || len(tailnet.stopped) != 0 ||
		tailnet.routes[*started.PublicPort] != *started.LocalPort {
		t.Fatalf("read-only observation mutated runtime: %#v %#v", processes.stopped, tailnet.stopped)
	}
}

func TestDifferentWorktreesReceiveDistinctSessionsAndPorts(t *testing.T) {
	firstProject := writeTestScripts(t)
	secondProject := writeTestScripts(t)
	manager, _, _, _ := newTestManager(t)

	first, err := manager.Start(context.Background(), firstProject, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Start(context.Background(), secondProject, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.ServerID == second.ServerID || first.TmuxSession == second.TmuxSession ||
		*first.LocalPort == *second.LocalPort || *first.PublicPort == *second.PublicPort ||
		first.LocalURL == nil || second.LocalURL == nil || *first.LocalURL == *second.LocalURL {
		t.Fatalf("worktree instances collided: first=%#v second=%#v", first, second)
	}
}

func TestPortlessStartFailureCompensatesBeforeTmuxStarts(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	portless := manager.portless.(*fakeLocalRouter)
	portless.startErr = errors.New("Portless unavailable")

	result, err := manager.Start(context.Background(), project, "dev", nil)
	if err == nil || !strings.Contains(err.Error(), "Portless unavailable") {
		t.Fatalf("start error = %v", err)
	}
	if result.State != StateFailed || result.LocalURL != nil || len(processes.started) != 0 ||
		len(tailnet.started) != 0 || len(portless.routes) != 0 {
		t.Fatalf("Portless compensation = result %#v processes %#v tailnet %#v routes %#v",
			result, processes.started, tailnet.started, portless.routes)
	}
}

func TestStopRefusesRepurposedPortlessRoute(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	started, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	portless := manager.portless.(*fakeLocalRouter)
	portless.routes[started.PortlessName] = 49999

	result, err := manager.Stop(context.Background(), project, "dev")
	if err == nil || !strings.Contains(err.Error(), "changed route") {
		t.Fatalf("stop error = %v", err)
	}
	if result.State != StateFailed || portless.routes[started.PortlessName] != 49999 ||
		len(processes.stopped) != 1 || len(tailnet.stopped) != 1 {
		t.Fatalf("repurposed Portless route changed: result=%#v routes=%#v", result, portless.routes)
	}
}

func TestPortBindRaceRetriesWithFreshPorts(t *testing.T) {
	project := writeTestScripts(t)
	ports := &sequencePorts{
		local: []int{43117, 43118}, public: []int{44419, 44420},
	}
	manager, processes, tailnet, prober := newTestManagerWithPorts(t, ports)
	prober.waitErrorsByPort[43117] = []error{errors.New("foreign listener won the port race")}
	processes.foreignPorts[43117] = true

	result, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.LocalPort == nil || *result.LocalPort != 43118 ||
		result.PublicPort == nil || *result.PublicPort != 44420 {
		t.Fatalf("retry result = %#v", result)
	}
	if len(processes.started) != 2 || len(processes.stopped) != 1 ||
		len(manager.tmux.(*fakeTmux).created) != 2 || len(tailnet.started) != 1 {
		t.Fatalf(
			"retry lifecycle = started %d stopped %d tmux %d routes %d",
			len(processes.started), len(processes.stopped), len(manager.tmux.(*fakeTmux).created), len(tailnet.started),
		)
	}
}

func TestPortRaceRetriesAreBounded(t *testing.T) {
	project := writeTestScripts(t)
	ports := &sequencePorts{
		local:  []int{43117, 43118, 43119, 43120},
		public: []int{44419, 44420, 44421, 44422},
	}
	manager, processes, tailnet, prober := newTestManagerWithPorts(t, ports)
	prober.waitErrors["127.0.0.1"] = errors.New("foreign listener keeps winning")
	portOpen := true
	processes.tcpOpen = &portOpen
	processes.owner = false

	result, err := manager.Start(context.Background(), project, "dev", nil)
	if err == nil || result.State != StateFailed {
		t.Fatalf("bounded retry result = %#v error = %v", result, err)
	}
	if len(processes.started) != maximumPortRaceAttempts || ports.localN != maximumPortRaceAttempts ||
		ports.publicN != maximumPortRaceAttempts || len(tailnet.started) != 0 {
		t.Fatalf(
			"retry was not bounded: processes %d local %d public %d routes %d",
			len(processes.started), ports.localN, ports.publicN, len(tailnet.started),
		)
	}
}

func TestStartRollsBackProcessAndExactRouteWhenPublicProbeFails(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, prober := newTestManager(t)
	prober.waitErrors[tailnet.ip] = errors.New("remote unavailable")

	result, err := manager.Start(context.Background(), project, "dev", nil)
	if err == nil {
		t.Fatal("expected start failure")
	}
	if result.State != StateError || result.PID != nil || result.PublicPort != nil {
		t.Fatalf("rollback result = %#v", result)
	}
	if len(processes.stopped) != 1 || len(tailnet.stopped) != 1 || len(tailnet.routes) != 0 {
		t.Fatalf("rollback incomplete: processes=%d routes=%#v stopped=%#v", len(processes.stopped), tailnet.routes, tailnet.stopped)
	}

	status, statusErr := manager.Status(context.Background(), project, "dev")
	if statusErr != nil {
		t.Fatal(statusErr)
	}
	if status.State != StateError || status.LastError == nil || !strings.Contains(*status.LastError, "remote unavailable") {
		t.Fatalf("error state was not retained: %#v", status)
	}
}

func TestLocalReadinessFailureDoesNotWaitForAReboundPortDuringRollback(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, _, prober := newTestManager(t)
	prober.waitErrors["127.0.0.1"] = errors.New("local unavailable")
	open := true
	processes.tcpOpen = &open

	if _, err := manager.Start(context.Background(), project, "dev", nil); err == nil {
		t.Fatal("expected start failure")
	}
	if len(processes.tcpChecks) != 0 {
		t.Fatalf("cleanup waited on a port that may have been rebound: %#v", processes.tcpChecks)
	}
	if len(processes.stopped) != 1 {
		t.Fatal("owned process group was not stopped")
	}
}

func TestTransientStatusFailurePreservesRuntimeAndRecovers(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, prober := newTestManager(t)
	started, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	prober.checkErrors["127.0.0.1"] = errors.New("temporary probe failure")

	status, err := manager.Status(context.Background(), project, "dev")
	if err == nil || !strings.Contains(err.Error(), "temporary probe failure") {
		t.Fatalf("status error = %v", err)
	}
	if status.State != StateError || status.PID != nil || status.PublicURL != nil || status.LastError == nil {
		t.Fatalf("transient status = %#v", status)
	}
	if len(processes.stopped) != 0 || tailnet.routes[*started.PublicPort] != *started.LocalPort {
		t.Fatalf("transient failure destroyed runtime: stopped=%#v routes=%#v", processes.stopped, tailnet.routes)
	}
	persisted, ok, loadErr := manager.store.load(mustTestIdentity(t, manager, started.Directory, "dev"))
	if loadErr != nil || !ok {
		t.Fatalf("load preserved runtime: ok=%v err=%v", ok, loadErr)
	}
	if persisted.State != StateRunning || persisted.PID != *started.PID || persisted.LastError == "" {
		t.Fatalf("persisted runtime = %#v", persisted)
	}

	delete(prober.checkErrors, "127.0.0.1")
	recovered, err := manager.Status(context.Background(), project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != StateRunning || recovered.PublicURL == nil || recovered.LastError != nil {
		t.Fatalf("recovered status = %#v", recovered)
	}
	if len(processes.stopped) != 0 {
		t.Fatal("recovery restarted or stopped the original runtime")
	}
}

func TestTransientReconcileFailureDoesNotCleanRuntime(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, prober := newTestManager(t)
	started, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	prober.checkErrors[tailnet.ip] = errors.New("temporary tailnet probe failure")

	result, err := manager.Reconcile(context.Background())
	if err == nil || !strings.Contains(err.Error(), "temporary tailnet probe failure") {
		t.Fatalf("reconcile error = %v", err)
	}
	if result.ErrorCount != 1 || len(result.Sessions) != 1 || result.Sessions[0].State != StateError ||
		result.Sessions[0].PublicURL != nil {
		t.Fatalf("reconcile result = %#v", result)
	}
	if len(processes.stopped) != 0 || tailnet.routes[*started.PublicPort] != *started.LocalPort {
		t.Fatalf("transient reconcile destroyed runtime: stopped=%#v routes=%#v", processes.stopped, tailnet.routes)
	}
}

func TestReconcileIsolatesCorruptStateAndChecksHealthySessions(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, _, _ := newTestManager(t)
	if _, err := manager.Start(context.Background(), project, "dev", nil); err != nil {
		t.Fatal(err)
	}
	corruptPath := filepath.Join(manager.store.root, "sessions", "corrupt.json")
	if err := os.WriteFile(corruptPath, []byte(`{"not":`), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := manager.Reconcile(context.Background())
	if err == nil || !strings.Contains(err.Error(), "corrupt.json") {
		t.Fatalf("reconcile error = %v", err)
	}
	if result.ErrorCount != 1 || len(result.Sessions) != 1 || result.Sessions[0].State != StateRunning {
		t.Fatalf("reconcile result = %#v", result)
	}
	if len(processes.stopped) != 0 {
		t.Fatal("corrupt state prevented the valid session from being preserved")
	}
	reserved, reserveErr := manager.reservedLocalPorts()
	if reserveErr != nil || !reserved[43117] {
		t.Fatalf("reserved ports = %#v error=%v", reserved, reserveErr)
	}
}

func TestInvalidUserHostDoesNotHideConfiguredCapability(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, _, _ := newTestManager(t)
	result, err := manager.Start(context.Background(), project, "dev", []string{"https://bad.example"})
	if err == nil {
		t.Fatal("expected allowed-host validation failure")
	}
	if result.Capability != CapabilityConfigured || result.State != StateError {
		t.Fatalf("result = %#v", result)
	}
	if len(processes.started) != 0 {
		t.Fatal("invalid user input launched a process")
	}
}

func TestStopRefusesRepurposedTailscalePort(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)
	started, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	tailnet.routes[*started.PublicPort] = 49999

	result, err := manager.Stop(context.Background(), project, "dev")
	if err == nil {
		t.Fatal("expected exact-route ownership failure")
	}
	if result.State != StateError || tailnet.routes[*started.PublicPort] != 49999 {
		t.Fatalf("repurposed route was changed: result=%#v routes=%#v", result, tailnet.routes)
	}
	if len(processes.stopped) != 1 {
		t.Fatal("owned dev process was not stopped after route ownership changed")
	}
}

func TestStatusRefusesToSignalReusedPID(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, _, _ := newTestManager(t)
	started, err := manager.Start(context.Background(), project, "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	processes.alive[*started.PID] = "replacement-process"

	status, err := manager.Status(context.Background(), project, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != StateError || status.LastError == nil {
		t.Fatalf("unexpected status: %#v", status)
	}
	if len(processes.stopped) != 0 {
		t.Fatal("a reused PID was signalled")
	}
}
