package machineconnect

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os/user"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestWSLServiceConnectorReplacesAndStartsWindowsScheduledTask(t *testing.T) {
	t.Setenv("PROJECT_CONNECTOR_REGISTRATION_TOKEN", "must-not-reach-task")
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "not-found\n"},
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
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe"}) {
		t.Fatalf("WSL start commands = %#v, want systemd cleanup then PowerShell", got)
	}
	if !containsArgument(runner.calls[0].arguments, machineConnectorSystemdUnit) {
		t.Fatalf("WSL start did not inspect the stale systemd unit: %#v", runner.calls[0])
	}
	powerShellCall := runner.calls[1]
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
		"RestartCount 999",
		"ExecutionTimeLimit ([TimeSpan]::Zero)",
		"Remove-ProjectConnectorTask",
	} {
		if !strings.Contains(script, required) {
			t.Errorf("scheduled task script lacks %q:\n%s", required, script)
		}
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

func TestWSLServiceConnectorStartsWithoutSystemdUserManager(t *testing.T) {
	for name, unavailable := range map[string]serviceCommandResponse{
		"missing systemctl": {err: missingServiceCommand("systemctl")},
		"missing user bus": {
			output: "Failed to connect to bus: No medium found\n",
			err:    errors.New("exit status 1"),
		},
	} {
		t.Run(name, func(t *testing.T) {
			runner := &scriptedServiceRunner{responses: []serviceCommandResponse{unavailable, {}}}
			connector := testServiceConnector(t, ServiceConnectorOptions{
				Executable: "/opt/project/bin/project",
				GOOS:       "linux",
				LinuxUser:  "oli",
				WSLDistro:  "Ubuntu-24.04",
			}, runner, &recordingServiceFiles{})

			if err := connector.Start(context.Background()); err != nil {
				t.Fatalf("start without systemd user manager: %v", err)
			}
			if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe"}) {
				t.Fatalf("start commands = %#v", got)
			}
		})
	}
}

func TestWSLServiceConnectorKeepsScheduledTaskFailuresHard(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "Failed to connect to bus: No medium found\n", err: errors.New("exit status 1")},
		{err: errors.New("scheduled task registration failed")},
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
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "powershell.exe"}) {
		t.Fatalf("failure commands = %#v", got)
	}
}

func TestWSLServiceConnectorStopsTaskAndStaleSystemdUnit(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{},
		{output: "loaded\n"},
		{},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})

	if err := connector.Stop(context.Background()); err != nil {
		t.Fatalf("stop WSL scheduled task: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(
		got,
		[]string{"powershell.exe", "systemctl", "systemctl", "systemctl"},
	) {
		t.Fatalf("WSL stop commands = %#v", got)
	}
	script := decodePowerShellCommand(t, runner.calls[0].arguments[len(runner.calls[0].arguments)-1])
	for _, required := range []string{"Get-ScheduledTask", "Stop-ScheduledTask", "Unregister-ScheduledTask"} {
		if !strings.Contains(script, required) {
			t.Errorf("scheduled task stop script lacks %q", required)
		}
	}
	if strings.Contains(script, "/opt/project/bin/project") || strings.Contains(script, "connector run") {
		t.Fatal("scheduled task stop embedded executable or runtime arguments")
	}
}

func TestWSLServiceConnectorStopDoesNotRequireSystemd(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{},
		{output: "Failed to connect to bus: No such file or directory\n", err: errors.New("exit status 1")},
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
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"powershell.exe", "systemctl"}) {
		t.Fatalf("stop commands = %#v", got)
	}
}

func TestWSLServiceConnectorJoinsTaskAndSystemdStopErrors(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{err: errors.New("task stop failed")},
		{err: errors.New("systemd inspect failed")},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
		LinuxUser:  "oli",
		WSLDistro:  "Ubuntu-24.04",
	}, runner, &recordingServiceFiles{})

	err := connector.Stop(context.Background())
	if err == nil || !strings.Contains(err.Error(), "task stop failed") ||
		!strings.Contains(err.Error(), "systemd inspect failed") {
		t.Fatalf("WSL stop error did not preserve both failures: %v", err)
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
