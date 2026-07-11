package machineconnect

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

const machineConnectorWindowsTask = "Project Space Machine Connector Supervisor"

func (connector *ServiceConnector) startWSLScheduledTask(ctx context.Context) error {
	if err := connector.stopSystemd(ctx); err != nil {
		return fmt.Errorf("remove stale WSL machine connector systemd service: %w", err)
	}
	if _, err := connector.runPowerShell(ctx, connector.wslStartScript()); err != nil {
		return fmt.Errorf("start WSL machine connector scheduled task: %w", err)
	}
	return nil
}

func (connector *ServiceConnector) stopWSLScheduledTask(ctx context.Context) error {
	_, taskErr := connector.runPowerShell(ctx, wslStopScript())
	if taskErr != nil {
		taskErr = fmt.Errorf("stop WSL machine connector scheduled task: %w", taskErr)
	}
	systemdErr := connector.stopSystemd(ctx)
	if systemdErr != nil {
		systemdErr = fmt.Errorf("remove stale WSL machine connector systemd service: %w", systemdErr)
	}
	return errors.Join(taskErr, systemdErr)
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
function Remove-ProjectConnectorTask {
  $task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { return }
  Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
}
Remove-ProjectConnectorTask
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wsl.exe') -Argument %s
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Description 'Keeps the authenticated Project Space connector running in WSL.' -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
} catch {
  Remove-ProjectConnectorTask
  throw
}
`, powershellLiteral(machineConnectorWindowsTask), powershellLiteral(actionArguments))
}

func wslStopScript() string {
	return fmt.Sprintf(`$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$taskName = %s
$taskPath = '\'
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
  Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
}
`, powershellLiteral(machineConnectorWindowsTask))
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
