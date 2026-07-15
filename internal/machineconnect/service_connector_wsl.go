package machineconnect

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	machineConnectorWindowsTaskPrefix = "Project Space Machine Connector Supervisor"
	maximumWindowsTaskNameLength      = 238
	maximumWindowsTaskRestartCount    = 255
	defaultWSLSystemdCleanupTimeout   = 5 * time.Second
)

func (connector *ServiceConnector) startWSLScheduledTask(ctx context.Context) error {
	if err := connector.cleanupStaleWSLSystemd(ctx); err != nil {
		return fmt.Errorf("remove stale WSL machine connector systemd service: %w", err)
	}
	if err := connector.removeWSLScheduledTaskAndWait(ctx); err != nil {
		return fmt.Errorf("stop previous WSL machine connector scheduled task: %w", err)
	}
	if _, err := connector.runPowerShell(ctx, connector.wslStartScript()); err != nil {
		startErr := fmt.Errorf("start WSL machine connector scheduled task: %w", err)
		if cleanupErr := connector.removeWSLScheduledTaskAndWait(ctx); cleanupErr != nil {
			return errors.Join(startErr, fmt.Errorf("clean up failed WSL machine connector start: %w", cleanupErr))
		}
		return startErr
	}
	return nil
}

func (connector *ServiceConnector) stopWSLScheduledTask(ctx context.Context) error {
	if err := connector.cleanupStaleWSLSystemd(ctx); err != nil {
		return fmt.Errorf("remove stale WSL machine connector systemd service: %w", err)
	}
	return connector.removeWSLScheduledTaskAndWait(ctx)
}

func (connector *ServiceConnector) removeWSLScheduledTaskAndWait(ctx context.Context) error {
	if _, err := connector.runPowerShell(ctx, connector.wslStopScript()); err != nil {
		return fmt.Errorf("stop WSL machine connector scheduled task: %w", err)
	}
	if connector.wslRuntimeStop == nil {
		return errors.New("verify WSL machine connector stop: runtime barrier is unavailable")
	}
	if err := connector.wslRuntimeStop(ctx, connector.executable); err != nil {
		return fmt.Errorf("verify WSL machine connector stop: %w", err)
	}
	return nil
}

func (connector *ServiceConnector) cleanupStaleWSLSystemd(ctx context.Context) error {
	timeout := connector.wslSystemdCleanupTimeout
	if timeout <= 0 {
		timeout = defaultWSLSystemdCleanupTimeout
	}
	cleanupCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err := connector.stopSystemd(cleanupCtx)
	if err == nil || systemdUserManagerUnavailable(err) {
		return nil
	}
	return err
}

func systemdUserManagerUnavailable(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if commandUnavailable(err) {
		return true
	}
	detail := strings.ToLower(err.Error())
	for _, marker := range []string{
		"failed to connect to bus",
		"no medium found",
		"system has not been booted with systemd",
		"transport endpoint is not connected",
		"user manager is not available",
		"could not be found",
	} {
		if strings.Contains(detail, marker) {
			return true
		}
	}
	return false
}

func (connector *ServiceConnector) runPowerShell(
	ctx context.Context,
	script string,
) ([]byte, error) {
	return connector.runner.Run(
		ctx,
		"powershell.exe",
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-EncodedCommand",
		encodePowerShellCommand(script),
	)
}

func (connector *ServiceConnector) wslStartScript() string {
	actionArguments := windowsCommandLine([]string{
		"-d",
		connector.wslDistro,
		"--user",
		connector.linuxUser,
		"--",
		connector.executable,
		"connector",
		"run",
	})
	return fmt.Sprintf(`$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$taskName = %s
$taskPath = '\'
%s
$registered = $false
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wsl.exe') -Argument %s
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount %d -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Description 'Keeps the authenticated Project Space connector running in WSL.' -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
  $registered = $true
  Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
} catch {
  if ($registered) { Remove-ProjectConnectorTask }
  throw
}
`,
		powershellLiteral(connector.wslTaskName),
		wslRemoveScheduledTaskPowerShell,
		powershellLiteral(actionArguments),
		maximumWindowsTaskRestartCount,
	)
}

func (connector *ServiceConnector) wslStopScript() string {
	return fmt.Sprintf(`$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$taskName = %s
$taskPath = '\'
%s
Remove-ProjectConnectorTask
exit 0
`, powershellLiteral(connector.wslTaskName), wslRemoveScheduledTaskPowerShell)
}

const wslRemoveScheduledTaskPowerShell = `function Stop-ProjectConnectorTask {
  param($task)
  $state = [string]$task.State
  if ($state -eq 'Ready' -or $state -eq 'Disabled') { return }
  if ($state -ne 'Running' -and $state -ne 'Queued') {
    throw "Refusing to remove a WSL connector task in unknown state '$state'."
  }
  Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
  $stopDeadline = (Get-Date).AddSeconds(15)
  do {
    $task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
    $state = [string]$task.State
    if ($state -eq 'Ready' -or $state -eq 'Disabled') { return }
    if ($state -ne 'Running' -and $state -ne 'Queued') {
      throw "The WSL connector task entered unknown state '$state' while stopping."
    }
    if ((Get-Date) -ge $stopDeadline) {
      throw 'Timed out waiting for the WSL connector task to stop.'
    }
    Start-Sleep -Milliseconds 100
  } while ($true)
}
function Remove-ProjectConnectorTask {
  $task = Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop |
    Where-Object { $_.TaskName -ceq $taskName } |
    Select-Object -First 1
  if ($null -eq $task) { return }
  Stop-ProjectConnectorTask $task
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
}`

func wslScheduledTaskName(distro string, linuxUser string) string {
	name := machineConnectorWindowsTaskPrefix +
		"~d" + strconv.Itoa(len(distro)) + "~" + distro +
		"~u" + strconv.Itoa(len(linuxUser)) + "~" + linuxUser
	if len(name) > maximumWindowsTaskNameLength {
		panic("validated WSL identity exceeded the Windows Scheduled Task name limit")
	}
	return name
}

func powershellLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func encodePowerShellCommand(script string) string {
	codeUnits := utf16.Encode([]rune(script))
	encoded := make([]byte, len(codeUnits)*2)
	for index, codeUnit := range codeUnits {
		binary.LittleEndian.PutUint16(encoded[index*2:], codeUnit)
	}
	return base64.StdEncoding.EncodeToString(encoded)
}

func windowsCommandLine(arguments []string) string {
	quoted := make([]string, len(arguments))
	for index, argument := range arguments {
		quoted[index] = windowsCommandLineArgument(argument)
	}
	return strings.Join(quoted, " ")
}

func windowsCommandLineArgument(value string) string {
	if value != "" && !strings.ContainsAny(value, " \t\"") {
		return value
	}
	var result strings.Builder
	result.WriteByte('"')
	backslashes := 0
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character == '\\' {
			backslashes++
			continue
		}
		if character == '"' {
			result.WriteString(strings.Repeat("\\", backslashes*2+1))
			result.WriteByte('"')
			backslashes = 0
			continue
		}
		result.WriteString(strings.Repeat("\\", backslashes))
		backslashes = 0
		result.WriteByte(character)
	}
	result.WriteString(strings.Repeat("\\", backslashes*2))
	result.WriteByte('"')
	return result.String()
}

func validWSLDistro(value string) bool {
	if len(value) == 0 || len(value) > 128 || !asciiAlphaNumeric(value[0]) ||
		!asciiAlphaNumeric(value[len(value)-1]) {
		return false
	}
	for index := 1; index < len(value)-1; index++ {
		character := value[index]
		if !asciiAlphaNumeric(character) && !strings.ContainsRune(" ._-", rune(character)) {
			return false
		}
	}
	return true
}

func validLinuxUser(value string) bool {
	if len(value) == 0 || len(value) > 32 ||
		!((value[0] >= 'a' && value[0] <= 'z') || value[0] == '_') {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if !(character >= 'a' && character <= 'z') &&
			!(character >= '0' && character <= '9') &&
			!strings.ContainsRune("_-", rune(character)) {
			return false
		}
	}
	return true
}

func asciiAlphaNumeric(character byte) bool {
	return character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
		character >= '0' && character <= '9'
}
