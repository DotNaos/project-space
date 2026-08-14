package projectrun

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRunForegroundCancellationStopsDescendants(t *testing.T) {
	if _, err := exec.LookPath("lsof"); err != nil {
		t.Skip("lsof is not installed")
	}
	port, err := (NetworkPortAllocator{}).Local(map[int]bool{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type outcome struct {
		exitCode int
		err      error
	}
	finished := make(chan outcome, 1)
	go func() {
		exitCode, runErr := (OSProcessRunner{}).RunForeground(ctx, Command{
			Argv: []string{os.Args[0], "-test.run=^TestProjectRunHelperProcess$", "--", "spawn"},
			Env: []string{
				"GO_WANT_PROJECTRUN_HELPER=1",
				"PROJECT_PORT=" + strconv.Itoa(port),
			},
		}, Streams{}, nil)
		finished <- outcome{exitCode: exitCode, err: runErr}
	}()
	if err := (NetworkProber{}).Wait(context.Background(), ProbeTarget{
		Host: "127.0.0.1", Port: port,
	}, 3*time.Second); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case result := <-finished:
		if !errors.Is(result.err, context.Canceled) {
			t.Fatalf("run error = %v", result.err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("foreground command did not stop after cancellation")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		open, err := (OSProcessRunner{}).TCPPortOpen(port)
		if err != nil {
			t.Fatal(err)
		}
		if !open {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("descendant listener on port %d was orphaned", port)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestManagedProcessIdentityAndPortOwnership(t *testing.T) {
	if _, err := exec.LookPath("lsof"); err != nil {
		t.Skip("lsof is not installed")
	}
	port, err := (NetworkPortAllocator{}).Local(map[int]bool{})
	if err != nil {
		t.Fatal(err)
	}
	runner := OSProcessRunner{SupervisorExecutable: buildProjectCLI(t)}
	command := Command{
		Argv: []string{os.Args[0], "-test.run=TestProjectRunHelperProcess", "--", "listen"},
		Env: []string{
			"GO_WANT_PROJECTRUN_HELPER=1",
			"PROJECT_PORT=" + strconv.Itoa(port),
		},
	}
	outputPath := t.TempDir() + "/helper.log"
	committed := false
	process, err := runner.StartDetached(command, outputPath, func(process ProcessRef) error {
		committed = process.PID > 0 && process.Identity != ""
		if tcpReachable(port) {
			return fmt.Errorf("managed command opened its port before the supervisor identity was committed")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !committed {
		t.Fatal("runtime supervisor identity was not committed before start returned")
	}
	defer runner.StopGroup(process, time.Second)
	if err := (NetworkProber{}).Wait(context.Background(), ProbeTarget{
		Host: "127.0.0.1", Port: port,
	}, 3*time.Second); err != nil {
		body, _ := os.ReadFile(outputPath)
		t.Fatalf("%v; helper output: %s", err, body)
	}
	if !runner.Alive(process) {
		t.Fatal("managed process identity was not retained")
	}
	owner, err := runner.OwnsTCP(process, "127.0.0.1", port)
	if err != nil {
		t.Fatal(err)
	}
	if !owner {
		t.Fatal("managed process group was not recognized as the listener owner")
	}

	wrong := process
	wrong.Identity = "replacement"
	if err := runner.StopGroup(wrong, time.Second); err == nil {
		t.Fatal("expected stale process identity to be refused")
	}
	if !runner.Alive(process) {
		t.Fatal("identity refusal stopped the real process")
	}
	if err := runner.StopGroup(process, time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestParseLinuxProcessStartTimeUsesFieldAfterParenthesizedName(t *testing.T) {
	fields := []string{"S"}
	for index := 0; index < 18; index++ {
		fields = append(fields, strconv.Itoa(index+1))
	}
	fields = append(fields, "987654321", "0", "0")
	startTime, err := parseLinuxProcessStartTime("42 (project supervisor) " + strings.Join(fields, " "))
	if err != nil {
		t.Fatal(err)
	}
	if startTime != "987654321" {
		t.Fatalf("start time = %q", startTime)
	}
}

func TestDetachedStartDoesNotLaunchCommandWhenCommitFails(t *testing.T) {
	port, err := (NetworkPortAllocator{}).Local(map[int]bool{})
	if err != nil {
		t.Fatal(err)
	}
	runner := OSProcessRunner{SupervisorExecutable: buildProjectCLI(t)}
	committed := ProcessRef{}
	_, err = runner.StartDetached(Command{
		Argv: []string{os.Args[0], "-test.run=TestProjectRunHelperProcess", "--", "listen"},
		Env: []string{
			"GO_WANT_PROJECTRUN_HELPER=1",
			"PROJECT_PORT=" + strconv.Itoa(port),
		},
	}, filepath.Join(t.TempDir(), "helper.log"), func(process ProcessRef) error {
		committed = process
		return errors.New("persist failed")
	})
	if err == nil || !strings.Contains(err.Error(), "persist failed") {
		t.Fatalf("start error = %v", err)
	}
	if committed.PID <= 0 || committed.Identity == "" {
		t.Fatal("commit callback did not receive the supervisor identity")
	}
	if runner.Alive(committed) {
		t.Fatal("supervisor remained alive after the commit failed")
	}
	if tcpReachable(port) {
		t.Fatal("managed command launched even though the supervisor identity was not persisted")
	}
}

func TestManagedOutputRefusesSymlinkWithoutTruncatingForeignFile(t *testing.T) {
	foreign := filepath.Join(t.TempDir(), "foreign.log")
	if err := os.WriteFile(foreign, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	// WriteFile applies the process umask; make the foreign target's mode
	// deterministic so the symlink rejection assertion is meaningful.
	if err := os.Chmod(foreign, 0o644); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(t.TempDir(), "runtime.log")
	if err := os.Symlink(foreign, linked); err != nil {
		t.Fatal(err)
	}
	if file, err := managedOutput(linked); err == nil {
		_ = file.Close()
		t.Fatal("symlink output was accepted")
	}
	body, err := os.ReadFile(foreign)
	info, statErr := os.Stat(foreign)
	if err != nil || statErr != nil || string(body) != "keep" || info.Mode().Perm() != 0o644 {
		t.Fatalf("foreign output changed: body=%q mode=%v readErr=%v statErr=%v", body, info.Mode().Perm(), err, statErr)
	}
}

func TestManagedRuntimeStopsItsProcessGroupOnSIGHUP(t *testing.T) {
	port, err := (NetworkPortAllocator{}).Local(map[int]bool{})
	if err != nil {
		t.Fatal(err)
	}
	runner := OSProcessRunner{SupervisorExecutable: buildProjectCLI(t)}
	process, err := runner.StartDetached(Command{
		Argv: []string{os.Args[0], "-test.run=TestProjectRunHelperProcess", "--", "spawn"},
		Env: []string{
			"GO_WANT_PROJECTRUN_HELPER=1",
			"PROJECT_PORT=" + strconv.Itoa(port),
		},
	}, filepath.Join(t.TempDir(), "helper.log"), func(ProcessRef) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer runner.StopGroup(process, time.Second)
	if err := (NetworkProber{}).Wait(context.Background(), ProbeTarget{
		Host: "127.0.0.1", Port: port,
	}, 3*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(process.PID, syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(6 * time.Second)
	for runner.Alive(process) || tcpReachable(port) {
		if time.Now().After(deadline) {
			t.Fatalf("runtime process group survived SIGHUP: pid=%d port=%d", process.PID, port)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestManagedRuntimeRecordsChildExit(t *testing.T) {
	runner := OSProcessRunner{SupervisorExecutable: buildProjectCLI(t)}
	root := t.TempDir()
	exitPath := filepath.Join(root, "watcher.exit")
	process, err := runner.StartDetached(Command{
		Argv: []string{os.Args[0], "-test.run=TestProjectRunHelperProcess", "--", "exit"},
		Env:  []string{"GO_WANT_PROJECTRUN_HELPER=1"}, ExitPath: exitPath,
	}, filepath.Join(root, "watcher.log"), func(ProcessRef) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer runner.StopGroup(process, time.Second)
	deadline := time.Now().Add(5 * time.Second)
	for {
		body, readErr := os.ReadFile(exitPath)
		if readErr == nil {
			if !strings.Contains(string(body), `"exitCode":7`) {
				t.Fatalf("exit marker = %s", body)
			}
			break
		}
		if !os.IsNotExist(readErr) {
			t.Fatal(readErr)
		}
		if time.Now().After(deadline) {
			t.Fatal("runtime supervisor did not record the child exit")
		}
		time.Sleep(25 * time.Millisecond)
	}
	manager := &Manager{processes: runner}
	err = manager.checkLocalNodeWatchers(runtimeState{Watchers: []LocalNodeWatcher{{
		Package: "@example/watcher", PID: process.PID, ProcessIdentity: process.Identity,
		ExitPath: exitPath, LogPath: filepath.Join(root, "watcher.log"),
	}}})
	if err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("watcher health error = %v", err)
	}
}

func TestExclusiveTCPOwnershipRejectsForeignCoListener(t *testing.T) {
	listeners := []tcpListener{
		{PID: 1001, Address: "127.0.0.1:43117"},
		{PID: 2001, Address: "127.0.0.1:43117"},
	}
	groups := map[int]int{1001: 7000, 2001: 8000}
	owned, err := ownsExclusiveTCP(7000, "127.0.0.1:43117", listeners, func(pid int) (int, error) {
		return groups[pid], nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if owned {
		t.Fatal("managed group was accepted despite a foreign co-listener")
	}
}

func TestProjectRunHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_PROJECTRUN_HELPER") != "1" {
		return
	}
	mode := "listen"
	for index, argument := range os.Args {
		if argument == "--" && index+1 < len(os.Args) {
			mode = os.Args[index+1]
			break
		}
	}
	if mode == "spawn" {
		child := exec.Command(os.Args[0], "-test.run=^TestProjectRunHelperProcess$", "--", "listen")
		child.Env = os.Environ()
		if err := child.Run(); err != nil {
			os.Exit(5)
		}
		os.Exit(0)
	}
	if mode == "exit" {
		os.Exit(7)
	}
	port, err := strconv.Atoi(os.Getenv("PROJECT_PORT"))
	if err != nil {
		os.Exit(2)
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		os.Exit(3)
	}
	defer listener.Close()
	for {
		connection, err := listener.Accept()
		if err != nil {
			os.Exit(4)
		}
		_ = connection.Close()
	}
}

func buildProjectCLI(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "project")
	cmd := exec.Command("go", "build", "-o", path, "./cmd/project")
	cmd.Dir = filepath.Join("..", "..")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build Project CLI: %v\n%s", err, output)
	}
	return path
}

func tcpReachable(port int) bool {
	connection, err := net.DialTimeout(
		"tcp4",
		net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		50*time.Millisecond,
	)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}
