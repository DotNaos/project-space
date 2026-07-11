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
	"time"
)

func TestServeLifecycleIsIdempotentAndExact(t *testing.T) {
	project := writeTestScripts(t)
	manager, processes, tailnet, _ := newTestManager(t)

	started, err := manager.Start(context.Background(), project, "dev", []string{
		"Preview.Example.com", "app.example.com", "preview.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	assertRunningResult(t, started)
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
		!containsEnvironment(command.Env, "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=") {
		t.Fatalf("managed environment = %#v", command.Env)
	}

	again, err := manager.Start(context.Background(), project, "dev", []string{
		"preview.example.com", "app.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	assertRunningResult(t, again)
	if len(processes.started) != 1 || len(tailnet.started) != 1 {
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

	if _, err := manager.Stop(context.Background(), project, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(tailnet.stopped) != 1 || len(processes.stopped) != 1 {
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
	if _, ok, loadErr := manager.store.load(project, "dev"); loadErr != nil || ok {
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
	persisted, ok, loadErr := manager.store.load(started.Directory, "dev")
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

func newTestManager(t *testing.T) (*Manager, *fakeProcesses, *fakeTailnet, *fakeProber) {
	t.Helper()
	processes := newFakeProcesses()
	tailnet := newFakeTailnet()
	prober := newFakeProber()
	manager, err := NewManager(Dependencies{
		Processes: processes,
		Tailnet:   tailnet,
		Prober:    prober,
		Ports:     fixedPorts{local: 43117, public: 44419},
		StateRoot: filepath.Join(t.TempDir(), "runtime"),
		Now: func() time.Time {
			return time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC)
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
	if result.SchemaVersion != 1 || result.Operation != "start" || result.State != StateRunning {
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
