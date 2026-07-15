package machineconnect

import (
	"context"
	"os/user"
	"strings"
	"testing"
)

const testWindowsSID = "S-1-5-21-111111111-222222222-333333333-1001"

func TestNativeWindowsServiceConnectorStartsCredentialFreeScheduledTask(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{{}}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/project.exe",
		GOOS:       "windows",
		WindowsSID: testWindowsSID,
	}, runner, &recordingServiceFiles{})

	if err := connector.Start(context.Background()); err != nil {
		t.Fatalf("start native Windows connector: %v", err)
	}
	if len(runner.calls) != 1 || runner.calls[0].name != "powershell.exe" {
		t.Fatalf("native Windows start calls = %#v", runner.calls)
	}
	call := runner.calls[0]
	for _, required := range []string{"-NoProfile", "-NonInteractive", "-EncodedCommand"} {
		if !containsArgument(call.arguments, required) {
			t.Fatalf("PowerShell arguments lack %q: %#v", required, call.arguments)
		}
	}
	script := decodePowerShellCommand(t, call.arguments[len(call.arguments)-1])
	for _, required := range []string{
		connector.windowsTaskName,
		connector.executable,
		"-Argument 'connector run'",
		"New-ScheduledTaskPrincipal",
		"-LogonType Interactive",
		"-RunLevel Limited",
		"New-ScheduledTaskTrigger -AtLogOn",
		"-MultipleInstances IgnoreNew",
		"RestartCount 255",
		"Register-ScheduledTask",
		"Start-ScheduledTask",
		"Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop",
		"Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop",
	} {
		if !strings.Contains(script, required) {
			t.Errorf("native Windows task script lacks %q:\n%s", required, script)
		}
	}
	if strings.Contains(script, "RestartCount 999") {
		t.Fatal("native Windows task used a restart count outside the Task Scheduler schema")
	}
	for _, forbidden := range []string{
		machineConnectorWindowsTaskPrefix,
		"wsl.exe",
		"credential",
		"PROJECT_",
		"machineId",
		"token",
	} {
		if strings.Contains(strings.ToLower(script), strings.ToLower(forbidden)) {
			t.Errorf("native Windows task script contains forbidden value %q", forbidden)
		}
	}
}

func TestNativeWindowsServiceConnectorStopIsIdempotentAndScoped(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{{}}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/project.exe",
		GOOS:       "windows",
		WindowsSID: testWindowsSID,
	}, runner, &recordingServiceFiles{})

	if err := connector.Stop(context.Background()); err != nil {
		t.Fatalf("stop native Windows connector: %v", err)
	}
	if len(runner.calls) != 1 || runner.calls[0].name != "powershell.exe" {
		t.Fatalf("native Windows stop calls = %#v", runner.calls)
	}
	script := decodePowerShellCommand(t, runner.calls[0].arguments[len(runner.calls[0].arguments)-1])
	if !strings.Contains(script, connector.windowsTaskName) ||
		!strings.Contains(script, "Unregister-ScheduledTask") ||
		!strings.Contains(script, "Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop") ||
		!strings.Contains(script, "Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop") ||
		!strings.Contains(script, "exit 0") {
		t.Fatalf("native Windows stop script is incomplete:\n%s", script)
	}
	if strings.Contains(script, machineConnectorWindowsTaskPrefix) ||
		strings.Contains(script, "wsl.exe") ||
		strings.Contains(script, "Get-CimInstance") ||
		strings.Contains(script, "Stop-Process") ||
		strings.Contains(script, "Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue") ||
		strings.Contains(script, "Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue") {
		t.Fatalf("native Windows stop script can target the WSL connector:\n%s", script)
	}
}

func TestNativeWindowsTaskNameIsStableAndUserScoped(t *testing.T) {
	first := nativeWindowsScheduledTaskName(testWindowsSID)
	if first != nativeWindowsScheduledTaskName(strings.ToLower(testWindowsSID)) {
		t.Fatal("native Windows task name is not case-stable")
	}
	second := nativeWindowsScheduledTaskName("S-1-5-21-111111111-222222222-333333333-1002")
	if first == second {
		t.Fatal("native Windows users share a task name")
	}
	if strings.HasPrefix(first, machineConnectorWindowsTaskPrefix) {
		t.Fatalf("native task name collides with WSL prefix: %q", first)
	}
}

func TestNativeWindowsServiceConnectorResolvesCurrentSID(t *testing.T) {
	options, err := serviceConnectorOptionsWithDefaults(
		ServiceConnectorOptions{GOOS: "windows"},
		nil,
		func() (*user.User, error) { return &user.User{Uid: testWindowsSID}, nil },
	)
	if err != nil {
		t.Fatalf("resolve current Windows SID: %v", err)
	}
	if options.WindowsSID != testWindowsSID {
		t.Fatalf("Windows SID = %q, want %q", options.WindowsSID, testWindowsSID)
	}
}

func TestNativeWindowsServiceConnectorRejectsInvalidSID(t *testing.T) {
	for _, sid := range []string{"", "user", "S-", "S-1--5", " S-1-5-21", "S-1-5-21\n"} {
		if _, err := newServiceConnector(
			ServiceConnectorOptions{
				Executable: "/opt/project/project.exe",
				GOOS:       "windows",
				WindowsSID: sid,
			},
			&scriptedServiceRunner{},
			&recordingServiceFiles{},
		); err == nil {
			t.Fatalf("accepted invalid Windows SID %q", sid)
		}
	}
}
