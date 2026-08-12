package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

func TestResolveAuthenticatedConnectorBinaryFindsPhysicalSibling(t *testing.T) {
	directory := t.TempDir()
	projectExecutable := filepath.Join(directory, projectExecutableName(runtime.GOOS))
	if err := os.WriteFile(projectExecutable, []byte("project"), 0o700); err != nil {
		t.Fatalf("write Project CLI fixture: %v", err)
	}
	companion := filepath.Join(directory, connectorBinaryName(runtime.GOOS))
	if err := os.WriteFile(companion, []byte("connector"), 0o700); err != nil {
		t.Fatalf("write sibling connector: %v", err)
	}

	resolved, err := resolveAuthenticatedConnectorBinary(projectExecutable, runtime.GOOS)
	if err != nil {
		t.Fatalf("resolve sibling connector: %v", err)
	}
	physicalCompanion, err := filepath.EvalSymlinks(companion)
	if err != nil {
		t.Fatalf("resolve physical connector fixture: %v", err)
	}
	if resolved != physicalCompanion {
		t.Fatalf("resolved connector = %q, want %q", resolved, physicalCompanion)
	}
}

func TestResolveAuthenticatedCodexHostBinaryFindsOnlyTheNewSibling(t *testing.T) {
	directory := t.TempDir()
	projectExecutable := filepath.Join(directory, projectExecutableName(runtime.GOOS))
	if err := os.WriteFile(projectExecutable, []byte("project"), 0o700); err != nil {
		t.Fatal(err)
	}
	name := "project-codex-host"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	host := filepath.Join(directory, name)
	if err := os.WriteFile(host, []byte("codex host"), 0o700); err != nil {
		t.Fatal(err)
	}
	resolved, err := resolveAuthenticatedCodexHostBinary(projectExecutable, runtime.GOOS)
	if err != nil {
		t.Fatal(err)
	}
	physicalHost, err := filepath.EvalSymlinks(host)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != physicalHost {
		t.Fatalf("resolved Codex host = %q, want %q", resolved, physicalHost)
	}
}

func TestAuthenticatedConnectorResolutionRejectsCWDAndPATHCandidates(t *testing.T) {
	projectDirectory := t.TempDir()
	projectExecutable := filepath.Join(projectDirectory, projectExecutableName(runtime.GOOS))
	if err := os.WriteFile(projectExecutable, []byte("project"), 0o700); err != nil {
		t.Fatalf("write Project CLI fixture: %v", err)
	}

	workingDirectory := t.TempDir()
	distDirectory := filepath.Join(workingDirectory, "dist")
	if err := os.MkdirAll(distDirectory, 0o700); err != nil {
		t.Fatalf("create dist fixture: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(distDirectory, connectorBinaryName(runtime.GOOS)),
		[]byte("cwd connector"),
		0o700,
	); err != nil {
		t.Fatalf("write CWD connector fixture: %v", err)
	}
	pathDirectory := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(pathDirectory, connectorBinaryName(runtime.GOOS)),
		[]byte("PATH connector"),
		0o700,
	); err != nil {
		t.Fatalf("write PATH connector fixture: %v", err)
	}

	originalWorkingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatalf("resolve working directory: %v", err)
	}
	if err := os.Chdir(workingDirectory); err != nil {
		t.Fatalf("change working directory: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(originalWorkingDirectory) })
	t.Setenv("PATH", pathDirectory)

	if resolved, err := resolveAuthenticatedConnectorBinary(projectExecutable, runtime.GOOS); err == nil {
		t.Fatalf("resolved non-sibling connector %q", resolved)
	}
}

func TestAuthenticatedConnectorResolutionRejectsSymlinkedSibling(t *testing.T) {
	directory := t.TempDir()
	projectExecutable := filepath.Join(directory, projectExecutableName(runtime.GOOS))
	if err := os.WriteFile(projectExecutable, []byte("project"), 0o700); err != nil {
		t.Fatalf("write Project CLI fixture: %v", err)
	}
	companionName := connectorBinaryName(runtime.GOOS)
	outside := filepath.Join(t.TempDir(), companionName)
	if err := os.WriteFile(outside, []byte("outside connector"), 0o700); err != nil {
		t.Fatalf("write outside connector fixture: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(directory, companionName)); err != nil {
		t.Skipf("create connector symlink: %v", err)
	}

	if resolved, err := resolveAuthenticatedConnectorBinary(projectExecutable, runtime.GOOS); err == nil {
		t.Fatalf("resolved symlinked connector %q", resolved)
	}
}

func projectExecutableName(goos string) string {
	if goos == "windows" {
		return "project.exe"
	}
	return "project"
}

func TestConnectorInstallerResolutionPreservesExplicitDevelopmentBinary(t *testing.T) {
	name := connectorBinaryName(runtime.GOOS)
	explicit := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(explicit, []byte("development connector"), 0o700); err != nil {
		t.Fatalf("write explicit connector fixture: %v", err)
	}

	resolved, err := resolveConnectorInstallerBinary(explicit)
	if err != nil {
		t.Fatalf("resolve explicit development connector: %v", err)
	}
	if resolved != explicit {
		t.Fatalf("resolved development connector = %q, want %q", resolved, explicit)
	}
}

func TestConnectorBinaryNameUsesWindowsExecutableSuffix(t *testing.T) {
	if got := connectorBinaryName("windows"); got != "project-space-connector.exe" {
		t.Fatalf("Windows connector binary name = %q", got)
	}
	if got := connectorBinaryName("linux"); got != "project-space-connector" {
		t.Fatalf("Linux connector binary name = %q", got)
	}
}

func TestUsableConnectorBinaryAcceptsWindowsExeWithoutUnixModeBits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "project-space-connector.exe")
	if err := os.WriteFile(path, []byte("MZ"), 0o600); err != nil {
		t.Fatalf("write Windows connector fixture: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("inspect Windows connector fixture: %v", err)
	}
	if !usableConnectorBinary(path, info, "windows") {
		t.Fatal("Windows connector executable was rejected for lacking Unix mode bits")
	}
	if usableConnectorBinary(strings.TrimSuffix(path, ".exe"), info, "windows") {
		t.Fatal("Windows connector accepted a non-EXE path")
	}
	if usableConnectorBinary(path, info, "linux") {
		t.Fatal("Linux connector accepted a non-executable file")
	}
}

type connectorRunSupervisor struct {
	runCalls int
	runErr   error
	runErrs  []error
	ctxErr   error
}

func (supervisor *connectorRunSupervisor) Run(ctx context.Context) error {
	supervisor.runCalls++
	supervisor.ctxErr = ctx.Err()
	if len(supervisor.runErrs) > 0 {
		err := supervisor.runErrs[0]
		supervisor.runErrs = supervisor.runErrs[1:]
		return err
	}
	return supervisor.runErr
}

func TestConnectorRunLoadsTheStoreAndRunsTheCompanionSupervisor(t *testing.T) {
	store := &commandStore{}
	supervisor := &connectorRunSupervisor{}
	newStoreCalls := 0
	resolveCalls := 0
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore: func() (machineconnect.CredentialStore, error) {
			newStoreCalls++
			return store, nil
		},
		ResolveBinary: func() (string, error) {
			resolveCalls++
			return "/opt/project/project-space-connector", nil
		},
		ConsumeReadinessAttempt: func() (string, bool, error) {
			return strings.Repeat("1", 64), true, nil
		},
		NewSupervisor: func(
			actualStore machineconnect.CredentialStore,
			binary string,
			readinessAttemptNonce string,
			_ io.Writer,
			_ io.Writer,
		) (connectorSupervisor, error) {
			if actualStore != store || binary != "/opt/project/project-space-connector" ||
				readinessAttemptNonce != strings.Repeat("1", 64) {
				t.Fatalf(
					"unexpected supervisor inputs: store=%T binary=%q attempt=%q",
					actualStore,
					binary,
					readinessAttemptNonce,
				)
			}
			return supervisor, nil
		},
	})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute connector run: %v", err)
	}
	if newStoreCalls != 1 || resolveCalls != 1 || supervisor.runCalls != 1 {
		t.Fatalf(
			"run calls = store %d, resolve %d, supervisor %d; want one each",
			newStoreCalls,
			resolveCalls,
			supervisor.runCalls,
		)
	}
}

func TestConnectorRunDeterministicallyRelaunchesAfterManagedRestart(t *testing.T) {
	store := &commandStore{}
	supervisor := &connectorRunSupervisor{runErrs: []error{
		machineconnect.ErrConnectorSupervisorRestartRequired,
		nil,
	}}
	relaunches := 0
	readinessAttempts := []string{}
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore:      func() (machineconnect.CredentialStore, error) { return store, nil },
		ResolveBinary: func() (string, error) { return "/managed/project-space-connector", nil },
		ConsumeReadinessAttempt: func() (string, bool, error) {
			return strings.Repeat("2", 64), true, nil
		},
		NewSupervisor: func(
			_ machineconnect.CredentialStore,
			_ string,
			readinessAttempt string,
			_ io.Writer,
			_ io.Writer,
		) (connectorSupervisor, error) {
			readinessAttempts = append(readinessAttempts, readinessAttempt)
			return supervisor, nil
		},
		RestartSupervisor: func(binary string) error {
			if binary != "/managed/project-space-connector" {
				t.Fatalf("relaunch binary = %q", binary)
			}
			relaunches++
			return nil
		},
	})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute managed restart: %v", err)
	}
	if supervisor.runCalls != 2 || relaunches != 1 ||
		!reflect.DeepEqual(readinessAttempts, []string{strings.Repeat("2", 64), ""}) {
		t.Fatalf(
			"managed restart calls = run %d relaunch %d readiness %#v",
			supervisor.runCalls,
			relaunches,
			readinessAttempts,
		)
	}
}

func TestConnectorRunFailsClosedWhenManagedRelaunchCannotResolve(t *testing.T) {
	store := &commandStore{}
	supervisor := &connectorRunSupervisor{runErr: machineconnect.ErrConnectorSupervisorRestartRequired}
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore:      func() (machineconnect.CredentialStore, error) { return store, nil },
		ResolveBinary: func() (string, error) { return "/managed/project-space-connector", nil },
		NewSupervisor: func(
			machineconnect.CredentialStore,
			string,
			string,
			io.Writer,
			io.Writer,
		) (connectorSupervisor, error) {
			return supervisor, nil
		},
		RestartSupervisor: func(string) error { return errors.New("untrusted managed pointer") },
	})

	err := command.Execute()
	if err == nil || !errors.Is(err, machineconnect.ErrConnectorSupervisorRestartRequired) ||
		!strings.Contains(err.Error(), "untrusted managed pointer") || supervisor.runCalls != 1 {
		t.Fatalf("managed relaunch failure = %v, run calls=%d", err, supervisor.runCalls)
	}
}

func TestConnectorRunDoesNotRelaunchAfterJoinedLifecycleFailure(t *testing.T) {
	store := &commandStore{}
	supervisor := &connectorRunSupervisor{runErr: errors.Join(
		machineconnect.ErrConnectorSupervisorRestartRequired,
		errors.New("release runtime lifetime"),
	)}
	relaunches := 0
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore:      func() (machineconnect.CredentialStore, error) { return store, nil },
		ResolveBinary: func() (string, error) { return "/managed/project-space-connector", nil },
		NewSupervisor: func(
			machineconnect.CredentialStore,
			string,
			string,
			io.Writer,
			io.Writer,
		) (connectorSupervisor, error) {
			return supervisor, nil
		},
		RestartSupervisor: func(string) error {
			relaunches++
			return nil
		},
	})

	err := command.Execute()
	if err == nil || relaunches != 0 || supervisor.runCalls != 1 {
		t.Fatalf("joined lifecycle failure = %v, run %d relaunch %d", err, supervisor.runCalls, relaunches)
	}
}

func TestConnectorRunOptionsCarryCompiledReleaseIdentity(t *testing.T) {
	previousReleaseID := projectMachineClientReleaseID
	previousBuildID := projectMachineClientBuildID
	projectMachineClientReleaseID = "v0.4.1"
	projectMachineClientBuildID = strings.Repeat("a", 40)
	t.Cleanup(func() {
		projectMachineClientReleaseID = previousReleaseID
		projectMachineClientBuildID = previousBuildID
	})

	options := connectorSupervisorOptions(
		"/opt/project/project-space-connector",
		strings.Repeat("1", 64),
		"/var/lib/project-space/codex-operations.json",
		io.Discard,
		io.Discard,
	)
	if options.Executable != "/opt/project/project-space-connector" ||
		options.BuildIdentity.ReleaseID != "v0.4.1" ||
		options.BuildIdentity.BuildID != strings.Repeat("a", 40) ||
		options.ReadinessAttemptNonce != strings.Repeat("1", 64) ||
		options.CodexOperationSnapshotPath != "/var/lib/project-space/codex-operations.json" {
		t.Fatalf("connector supervisor options = %#v", options)
	}
}

func TestConnectorRunStopsBeforeLaunchingWhenCredentialStoreFails(t *testing.T) {
	supervisor := &connectorRunSupervisor{}
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore: func() (machineconnect.CredentialStore, error) {
			return nil, errors.New("secure store unavailable")
		},
		ResolveBinary: func() (string, error) {
			t.Fatal("resolved companion after store failure")
			return "", nil
		},
		NewSupervisor: func(
			machineconnect.CredentialStore,
			string,
			string,
			io.Writer,
			io.Writer,
		) (connectorSupervisor, error) {
			return supervisor, nil
		},
	})

	if err := command.Execute(); err == nil {
		t.Fatal("expected secure store failure")
	}
	if supervisor.runCalls != 0 {
		t.Fatal("supervisor ran after store failure")
	}
}

func TestConnectorRunPropagatesCommandCancellation(t *testing.T) {
	store := &commandStore{}
	supervisor := &connectorRunSupervisor{}
	command := newConnectorRunCommandWithDependencies(connectorRunDependencies{
		NewStore:      func() (machineconnect.CredentialStore, error) { return store, nil },
		ResolveBinary: func() (string, error) { return "/opt/project/project-space-connector", nil },
		NewSupervisor: func(
			machineconnect.CredentialStore,
			string,
			string,
			io.Writer,
			io.Writer,
		) (connectorSupervisor, error) {
			return supervisor, nil
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	command.SetContext(ctx)

	if err := command.Execute(); err != nil {
		t.Fatalf("execute cancelled connector run: %v", err)
	}
	if !errors.Is(supervisor.ctxErr, context.Canceled) {
		t.Fatalf("supervisor context error = %v, want cancellation", supervisor.ctxErr)
	}
}

func TestConnectorCommandRegistersAuthenticatedRun(t *testing.T) {
	command := newConnectorCommand()
	if len(command.Commands()) != 0 {
		t.Fatalf("retired connector command still registers subcommands: %#v", command.Commands())
	}
}
