package machineconnect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type wslQuiescenceFixture struct {
	companion string
	procRoot  string
	project   string
}

func newWSLQuiescenceFixture(t *testing.T) wslQuiescenceFixture {
	t.Helper()
	root := t.TempDir()
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	release := filepath.Join(
		root,
		".project-space-machine-tools",
		connectorSupervisorVersionsDirectoryName,
		"0.4.7-test",
	)
	if err := os.MkdirAll(release, 0o700); err != nil {
		t.Fatal(err)
	}
	fixture := wslQuiescenceFixture{
		companion: filepath.Join(release, "project-space-connector"),
		procRoot:  filepath.Join(root, "proc"),
		project:   filepath.Join(release, "project"),
	}
	if err := os.Mkdir(fixture.procRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, executable := range []string{fixture.project, fixture.companion} {
		if err := os.WriteFile(executable, []byte("fixture\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return fixture
}

func (fixture wslQuiescenceFixture) writeProcess(
	t *testing.T,
	pid string,
	executable string,
	arguments ...string,
) string {
	t.Helper()
	processRoot := filepath.Join(fixture.procRoot, pid)
	if err := os.Mkdir(processRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(executable, filepath.Join(processRoot, "exe")); err != nil {
		t.Fatal(err)
	}
	commandLine := strings.Join(arguments, "\x00") + "\x00"
	if err := os.WriteFile(filepath.Join(processRoot, "cmdline"), []byte(commandLine), 0o600); err != nil {
		t.Fatal(err)
	}
	return processRoot
}

func TestWSLConnectorQuiescenceRecognizesOnlyManagedRuntimeProcesses(t *testing.T) {
	fixture := newWSLQuiescenceFixture(t)
	matcher, err := newWSLConnectorProcessMatcher(fixture.project)
	if err != nil {
		t.Fatal(err)
	}
	devRuntime := fixture.writeProcess(
		t,
		"101",
		fixture.project,
		fixture.project,
		"__runtime-supervisor",
		"runtime.log",
	)
	running, err := matcher.running(fixture.procRoot)
	if err != nil || running {
		t.Fatalf("dev runtime matched connector supervisor: running=%v err=%v", running, err)
	}
	if err := os.RemoveAll(devRuntime); err != nil {
		t.Fatal(err)
	}

	supervisor := fixture.writeProcess(
		t,
		"102",
		fixture.project,
		fixture.project,
		"connector",
		"run",
	)
	running, err = matcher.running(fixture.procRoot)
	if err != nil || !running {
		t.Fatalf("managed supervisor was missed: running=%v err=%v", running, err)
	}
	if err := os.RemoveAll(supervisor); err != nil {
		t.Fatal(err)
	}

	fixture.writeProcess(t, "103", fixture.companion+" (deleted)", fixture.companion)
	running, err = matcher.running(fixture.procRoot)
	if err != nil || !running {
		t.Fatalf("managed companion was missed: running=%v err=%v", running, err)
	}
}

func TestWSLConnectorQuiescenceWaitsForLinuxProcesses(t *testing.T) {
	fixture := newWSLQuiescenceFixture(t)
	processRoot := fixture.writeProcess(
		t,
		"201",
		fixture.project,
		fixture.project,
		"connector",
		"run",
	)
	done := make(chan error, 1)
	go func() {
		done <- waitForWSLConnectorRuntimeStopAt(
			context.Background(),
			fixture.project,
			fixture.procRoot,
			time.Second,
			time.Millisecond,
		)
	}()
	time.Sleep(10 * time.Millisecond)
	if err := os.RemoveAll(processRoot); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("wait for managed process exit: %v", err)
	}
}

func TestWSLConnectorQuiescenceTimesOutWhileCompanionRuns(t *testing.T) {
	fixture := newWSLQuiescenceFixture(t)
	fixture.writeProcess(t, "301", fixture.companion, fixture.companion)
	err := waitForWSLConnectorRuntimeStopAt(
		context.Background(),
		fixture.project,
		fixture.procRoot,
		20*time.Millisecond,
		time.Millisecond,
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("running companion did not block stop: %v", err)
	}
}

func TestWSLConnectorQuiescenceRejectsOversizedSupervisorArguments(t *testing.T) {
	fixture := newWSLQuiescenceFixture(t)
	fixture.writeProcess(
		t,
		"401",
		fixture.project,
		fixture.project,
		"connector",
		"run",
		strings.Repeat("x", maximumWSLProcessCommandLength),
	)
	matcher, err := newWSLConnectorProcessMatcher(fixture.project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := matcher.running(fixture.procRoot); err == nil ||
		!strings.Contains(err.Error(), "arguments are too large") {
		t.Fatalf("oversized command line was accepted: %v", err)
	}
}
