package machineconnect

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

type blockingWSLSystemdRunner struct {
	calls []serviceCommandCall
}

func (runner *blockingWSLSystemdRunner) Run(
	ctx context.Context,
	name string,
	arguments ...string,
) ([]byte, error) {
	runner.calls = append(runner.calls, serviceCommandCall{
		name:      name,
		arguments: append([]string(nil), arguments...),
	})
	if name != "systemctl" {
		return nil, nil
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestWSLServiceConnectorReplacesAndStartsWindowsScheduledTask(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the WSL supervisor runs inside the Linux distribution")
	}
	t.Setenv("PROJECT_CONNECTOR_REGISTRATION_TOKEN", "must-not-reach-task")
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "not-found\n"},
		{},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/home/oli/Project Space/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu Dev 24.04",
	}, runner, &recordingServiceFiles{})

	if err := connector.Start(context.Background()); err != nil {
		t.Fatalf("start WSL scheduled task: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe", "powershell.exe"}) {
		t.Fatalf("WSL start commands = %#v, want cleanup, hard stop, then registration", got)
	}
	if !containsArgument(runner.calls[0].arguments, machineConnectorSystemdUnit) {
		t.Fatalf("WSL start did not inspect the stale systemd unit: %#v", runner.calls[0])
	}
	stopScript := decodePowerShellCommand(t, runner.calls[1].arguments[len(runner.calls[1].arguments)-1])
	if !strings.Contains(stopScript, "Remove-ProjectConnectorTask") {
		t.Fatalf("WSL start did not hard-stop the previous task first:\n%s", stopScript)
	}
	powerShellCall := runner.calls[2]
	if !containsArgument(powerShellCall.arguments, "-EncodedCommand") ||
		!containsArgument(powerShellCall.arguments, "-NonInteractive") {
		t.Fatalf("PowerShell invocation is not non-interactive and encoded: %#v", powerShellCall)
	}
	script := decodePowerShellCommand(t, powerShellCall.arguments[len(powerShellCall.arguments)-1])
	for _, required := range []string{
		connector.wslTaskName,
		"Register-ScheduledTask",
		"Start-ScheduledTask",
		"New-ScheduledTaskTrigger -AtLogOn -User $identity",
		"New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited",
		"System32\\wsl.exe",
		`-d "Ubuntu Dev 24.04" --user oli -- "/home/oli/Project Space/bin/project" connector run`,
		"RestartCount 255",
		"ExecutionTimeLimit ([TimeSpan]::Zero)",
		"Remove-ProjectConnectorTask",
		"Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop",
		"Where-Object { $_.TaskName -ceq $taskName }",
		"Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop",
		"Timed out waiting for the WSL connector task to stop.",
	} {
		if !strings.Contains(script, required) {
			t.Errorf("scheduled task script lacks %q:\n%s", required, script)
		}
	}
	if strings.Contains(script, "RestartCount 999") {
		t.Fatal("scheduled task used a restart count outside the Task Scheduler schema")
	}
	if strings.Contains(script, "Register-ScheduledTask") && strings.Contains(script, " -Force") {
		t.Fatal("scheduled task registration can overwrite a racing connector task")
	}
	if strings.Contains(
		script,
		"Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue",
	) {
		t.Fatal("scheduled task replacement can hide a failed stop")
	}
	if strings.Contains(script, "Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue") {
		t.Fatal("scheduled task replacement can hide a failed task inspection")
	}
	joinedCalls := serviceCallsText(runner.calls)
	for _, forbidden := range []string{
		"must-not-reach-task",
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN",
		"PROJECT_SPACE_CONNECTOR_RUNTIME_PROTOCOL",
		"privateKey",
		"machine-credential.json",
	} {
		if strings.Contains(joinedCalls+script, forbidden) {
			t.Errorf("scheduled task command exposed forbidden value %q", forbidden)
		}
	}
}

func TestWSLServiceConnectorUsesManagedCurrentProjectAcrossPointerSwitch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the WSL supervisor runs inside the Linux distribution")
	}
	installRoot := t.TempDir()
	toolsRoot := filepath.Join(installRoot, ".project-space-machine-tools")
	versionsRoot := filepath.Join(toolsRoot, connectorSupervisorVersionsDirectoryName)
	oldRelease := filepath.Join(versionsRoot, "0.4.5-aaaaaaaaaaaaaaaa")
	newRelease := filepath.Join(versionsRoot, "0.4.6-bbbbbbbbbbbbbbbb")
	for _, release := range []string{oldRelease, newRelease} {
		if err := os.MkdirAll(release, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(release, "project"), []byte("project\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	current := filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName)
	if err := os.Symlink(filepath.ToSlash(filepath.Join(
		connectorSupervisorVersionsDirectoryName,
		filepath.Base(oldRelease),
	)), current); err != nil {
		t.Fatal(err)
	}

	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: filepath.Join(oldRelease, "project"),
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, &scriptedServiceRunner{}, &recordingServiceFiles{})
	resolvedInstallRoot, err := filepath.EvalSymlinks(installRoot)
	if err != nil {
		t.Fatal(err)
	}
	stable := filepath.Join(
		resolvedInstallRoot,
		".project-space-machine-tools",
		connectorSupervisorCurrentPointerName,
		"project",
	)
	if connector.executable != stable {
		t.Fatalf("WSL service executable = %q, want stable path %q", connector.executable, stable)
	}
	if script := connector.wslStartScript(); !strings.Contains(script, stable) ||
		strings.Contains(script, oldRelease) {
		t.Fatalf("WSL scheduled task did not use only the stable managed path:\n%s", script)
	}

	if err := os.Remove(current); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.ToSlash(filepath.Join(
		connectorSupervisorVersionsDirectoryName,
		filepath.Base(newRelease),
	)), current); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(connector.executable)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(
		resolvedInstallRoot,
		".project-space-machine-tools",
		connectorSupervisorVersionsDirectoryName,
		filepath.Base(newRelease),
		"project",
	); resolved != want {
		t.Fatalf("stable WSL service path resolved to %q after update, want %q", resolved, want)
	}
}

func TestWSLServiceConnectorBoundsStaleSystemdCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the WSL supervisor runs inside the Linux distribution")
	}
	for name, run := range map[string]func(*ServiceConnector, context.Context) error{
		"start": (*ServiceConnector).Start,
		"stop":  (*ServiceConnector).Stop,
	} {
		t.Run(name, func(t *testing.T) {
			runner := &blockingWSLSystemdRunner{}
			connector := testServiceConnector(t, ServiceConnectorOptions{
				Executable: "/opt/project/bin/project",
				GOOS:       "linux",
				LinuxUser:  "oli",
				WSLDistro:  "Ubuntu-24.04",
			}, runner, &recordingServiceFiles{})
			connector.wslSystemdCleanupTimeout = 20 * time.Millisecond
			startedAt := time.Now()
			err := run(connector, context.Background())
			if err == nil || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("%s WSL service accepted unverified systemd cleanup: %v", name, err)
			}
			if elapsed := time.Since(startedAt); elapsed > time.Second {
				t.Fatalf("%s WSL service took %s with bounded systemd cleanup", name, elapsed)
			}
			want := []string{"systemctl"}
			if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, want) {
				t.Fatalf("%s WSL service calls = %#v, want %#v", name, got, want)
			}
		})
	}
}

func TestWSLServiceConnectorStartsWithoutSystemdUserManager(t *testing.T) {
	for name, unavailable := range map[string]serviceCommandResponse{
		"missing systemctl": {err: missingServiceCommand("systemctl")},
		"missing user bus": {
			output: "Failed to connect to bus: No medium found\n",
			err:    errors.New("exit status 1"),
		},
	} {
		t.Run(name, func(t *testing.T) {
			runner := &scriptedServiceRunner{responses: []serviceCommandResponse{unavailable, {}, {}}}
			connector := testServiceConnector(t, ServiceConnectorOptions{
				Executable: "/opt/project/bin/project",
				GOOS:       "linux",
				LinuxUser:  "oli",
				WSLDistro:  "Ubuntu-24.04",
			}, runner, &recordingServiceFiles{})

			if err := connector.Start(context.Background()); err != nil {
				t.Fatalf("start without systemd user manager: %v", err)
			}
			if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe", "powershell.exe"}) {
				t.Fatalf("start commands = %#v", got)
			}
		})
	}
}

func TestWSLServiceConnectorKeepsScheduledTaskFailuresHard(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "Failed to connect to bus: No medium found\n", err: errors.New("exit status 1")},
		{},
		{err: errors.New("scheduled task registration failed")},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})

	err := connector.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "scheduled task registration failed") {
		t.Fatalf("scheduled task failure was hidden: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe", "powershell.exe", "powershell.exe"}) {
		t.Fatalf("failure commands = %#v", got)
	}
}

func TestWSLServiceConnectorStartStopsBeforeRegistering(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "not-found\n"},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})
	connector.wslRuntimeStop = func(context.Context, string) error {
		return errors.New("orphaned managed companion is still running")
	}

	err := connector.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "orphaned managed companion is still running") {
		t.Fatalf("WSL start hid the runtime barrier failure: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe"}) {
		t.Fatalf("WSL start continued after failed runtime barrier: %#v", got)
	}
}

func TestWSLServiceConnectorStopsTaskAndStaleSystemdUnit(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "loaded\n"},
		{},
		{},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})
	barrierCalls := 0
	connector.wslRuntimeStop = func(_ context.Context, executable string) error {
		barrierCalls++
		if executable != connector.executable {
			t.Fatalf("runtime barrier executable = %q, want %q", executable, connector.executable)
		}
		return nil
	}

	if err := connector.Stop(context.Background()); err != nil {
		t.Fatalf("stop WSL scheduled task: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(
		got,
		[]string{"systemctl", "systemctl", "systemctl", "powershell.exe"},
	) {
		t.Fatalf("WSL stop commands = %#v", got)
	}
	if barrierCalls != 1 {
		t.Fatalf("WSL runtime barrier calls = %d, want 1", barrierCalls)
	}
	script := decodePowerShellCommand(t, runner.calls[3].arguments[len(runner.calls[3].arguments)-1])
	for _, required := range []string{
		"Get-ScheduledTask",
		"Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop",
		"Where-Object { $_.TaskName -ceq $taskName }",
		"Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop",
		"Timed out waiting for the WSL connector task to stop.",
		"Unregister-ScheduledTask",
	} {
		if !strings.Contains(script, required) {
			t.Errorf("scheduled task stop script lacks %q", required)
		}
	}
	if strings.Contains(
		script,
		"Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue",
	) {
		t.Fatal("scheduled task stop can hide a failure and leave a maintenance writer running")
	}
	if strings.Contains(script, "Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue") {
		t.Fatal("scheduled task stop can hide a failed task inspection")
	}
	if strings.Contains(script, "/opt/project/bin/project") || strings.Contains(script, "connector run") {
		t.Fatal("scheduled task stop embedded executable or runtime arguments")
	}
}

func TestWSLServiceConnectorDoesNotHideRuntimeBarrierFailure(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "not-found\n"},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})
	connector.wslRuntimeStop = func(context.Context, string) error {
		return errors.New("managed companion is still running")
	}

	err := connector.Stop(context.Background())
	if err == nil || !strings.Contains(err.Error(), "managed companion is still running") {
		t.Fatalf("WSL runtime barrier failure was hidden: %v", err)
	}
}

func TestWSLServiceConnectorStopDoesNotRequireSystemd(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "Failed to connect to bus: No such file or directory\n", err: errors.New("exit status 1")},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})

	if err := connector.Stop(context.Background()); err != nil {
		t.Fatalf("stop without systemd user manager: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe"}) {
		t.Fatalf("stop commands = %#v", got)
	}
}

func TestWSLServiceConnectorDoesNotTouchTaskAfterSystemdStopFailure(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{{
		err: errors.New("systemd inspect failed"),
	}}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})

	err := connector.Stop(context.Background())
	if err == nil || !strings.Contains(err.Error(), "systemd inspect failed") {
		t.Fatalf("WSL stop hid the systemd failure: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl"}) {
		t.Fatalf("WSL stop touched the task after unverified cleanup: %#v", got)
	}
}

func TestWSLServiceConnectorKeepsTaskStopFailuresHard(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "not-found\n"},
		{err: errors.New("task stop failed")},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})

	err := connector.Stop(context.Background())
	if err == nil || !strings.Contains(err.Error(), "task stop failed") {
		t.Fatalf("WSL stop hid the scheduled task failure: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe"}) {
		t.Fatalf("WSL stop commands = %#v", got)
	}
}

func TestWSLServiceConnectorDefaultsFromRuntimeIdentity(t *testing.T) {
	options, err := serviceConnectorOptionsWithDefaults(
		ServiceConnectorOptions{Executable: "/opt/project/bin/project", GOOS: "linux"},
		func(name string) string {
			if name == "WSL_DISTRO_NAME" {
				return "Ubuntu-24.04"
			}
			return ""
		},
		func() (*user.User, error) { return &user.User{Username: "oli"}, nil },
	)
	if err != nil {
		t.Fatalf("resolve WSL defaults: %v", err)
	}
	if options.WSLDistro != "Ubuntu-24.04" || options.LinuxUser != "oli" {
		t.Fatalf("WSL defaults = %#v", options)
	}

	userLookups := 0
	macOptions, err := serviceConnectorOptionsWithDefaults(
		ServiceConnectorOptions{GOOS: "darwin"},
		func(string) string { return "Ubuntu-24.04" },
		func() (*user.User, error) {
			userLookups++
			return &user.User{Username: "wrong"}, nil
		},
	)
	if err != nil || macOptions.WSLDistro != "" || userLookups != 0 {
		t.Fatalf("non-Linux defaults unexpectedly enabled WSL: options=%#v lookups=%d err=%v", macOptions, userLookups, err)
	}
}

func TestWSLScheduledTaskNamesIsolateDistributionsAndUsers(t *testing.T) {
	identities := []struct {
		distro string
		user   string
	}{
		{distro: "Ubuntu", user: "dev-oli"},
		{distro: "Ubuntu-dev", user: "oli"},
		{distro: "Debian", user: "oli"},
	}
	connectors := make([]*ServiceConnector, 0, len(identities))
	seen := map[string]bool{}
	for _, identity := range identities {
		connector := testServiceConnector(t, ServiceConnectorOptions{
			Executable: "/opt/project/bin/project",
			GOOS:       "linux",
			LinuxUser:  identity.user,
			WSLDistro:  identity.distro,
		}, &scriptedServiceRunner{}, &recordingServiceFiles{})
		if seen[connector.wslTaskName] {
			t.Fatalf("scheduled task name collision for %#v: %q", identity, connector.wslTaskName)
		}
		seen[connector.wslTaskName] = true
		if !strings.HasPrefix(connector.wslTaskName, machineConnectorWindowsTaskPrefix) ||
			len(connector.wslTaskName) > maximumWindowsTaskNameLength ||
			strings.ContainsAny(connector.wslTaskName, `\/:*?"<>|`) {
			t.Fatalf("invalid Windows Scheduled Task name %q", connector.wslTaskName)
		}
		connectors = append(connectors, connector)
	}

	for index, connector := range connectors {
		startScript := connector.wslStartScript()
		stopScript := connector.wslStopScript()
		if !strings.Contains(stopScript, "exit 0") {
			t.Fatalf("WSL task stop is not idempotent under Windows PowerShell 5.1")
		}
		for _, script := range []string{startScript, stopScript} {
			if !strings.Contains(script, powershellLiteral(connector.wslTaskName)) {
				t.Fatalf("start/stop script did not use its exact task name %q", connector.wslTaskName)
			}
		}
		for otherIndex, other := range connectors {
			if index != otherIndex && strings.Contains(stopScript, powershellLiteral(other.wslTaskName)) {
				t.Fatalf("disconnect for %q targeted %q", connector.wslTaskName, other.wslTaskName)
			}
		}
	}

	maximumName := wslScheduledTaskName(
		"A"+strings.Repeat(" ", 126)+"Z",
		"a"+strings.Repeat("b", 31),
	)
	if len(maximumName) > maximumWindowsTaskNameLength || strings.ContainsAny(maximumName, `\/:*?"<>|`) {
		t.Fatalf("maximum valid task name is not Windows-safe: length=%d name=%q", len(maximumName), maximumName)
	}
}

func TestWSLServiceConnectorRejectsInvalidIdentityInputs(t *testing.T) {
	valid := ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}
	tests := map[string]func(*ServiceConnectorOptions){
		"control in executable": func(options *ServiceConnectorOptions) { options.Executable += "\n" },
		"distro on macOS":       func(options *ServiceConnectorOptions) { options.GOOS = "darwin" },
		"empty Linux user":      func(options *ServiceConnectorOptions) { options.LinuxUser = "" },
		"invalid distro slash":  func(options *ServiceConnectorOptions) { options.WSLDistro = "Ubuntu/24" },
		"invalid Linux user":    func(options *ServiceConnectorOptions) { options.LinuxUser = "Oli" },
		"padded distro":         func(options *ServiceConnectorOptions) { options.WSLDistro = " Ubuntu-24.04 " },
		"user without distro":   func(options *ServiceConnectorOptions) { options.WSLDistro = "" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			candidate := valid
			mutate(&candidate)
			if _, err := newServiceConnector(
				candidate,
				&scriptedServiceRunner{},
				&recordingServiceFiles{},
			); err == nil {
				t.Fatal("expected invalid WSL service input error")
			}
		})
	}
}

func TestWindowsCommandLineQuotesWSLArguments(t *testing.T) {
	arguments := windowsCommandLine([]string{
		"-d",
		"Ubuntu Dev",
		"--",
		`/home/oli/a "quoted" path/project`,
		`trailing slash \\`,
	})
	want := `-d "Ubuntu Dev" -- "/home/oli/a \"quoted\" path/project" "trailing slash \\\\"`
	if arguments != want {
		t.Fatalf("Windows command line = %q, want %q", arguments, want)
	}
	if literal := powershellLiteral("Project's connector"); literal != "'Project''s connector'" {
		t.Fatalf("PowerShell literal = %q", literal)
	}
}

func decodePowerShellCommand(t *testing.T, encoded string) string {
	t.Helper()
	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(payload)%2 != 0 {
		t.Fatalf("decode PowerShell command: bytes=%d err=%v", len(payload), err)
	}
	codeUnits := make([]uint16, len(payload)/2)
	for index := range codeUnits {
		codeUnits[index] = binary.LittleEndian.Uint16(payload[index*2:])
	}
	return string(utf16.Decode(codeUnits))
}

func serviceCallsText(calls []serviceCommandCall) string {
	var values []string
	for _, call := range calls {
		values = append(values, call.name)
		values = append(values, call.arguments...)
	}
	return strings.Join(values, "\n")
}
