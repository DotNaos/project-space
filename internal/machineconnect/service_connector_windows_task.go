package machineconnect

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
)

const machineConnectorNativeWindowsTaskPrefix = "Project Space Native Machine Connector Supervisor"

func (connector *ServiceConnector) startWindowsScheduledTask(ctx context.Context) error {
	if _, err := connector.runPowerShell(ctx, connector.windowsStartScript()); err != nil {
		return fmt.Errorf("start native Windows machine connector scheduled task: %w", err)
	}
	return nil
}

func (connector *ServiceConnector) stopWindowsScheduledTask(ctx context.Context) error {
	if _, err := connector.runPowerShell(ctx, connector.windowsStopScript()); err != nil {
		return fmt.Errorf("stop native Windows machine connector scheduled task: %w", err)
	}
	return nil
}

func (connector *ServiceConnector) windowsStartScript() string {
	actionArguments := windowsCommandLine([]string{"connector", "run"})
	return fmt.Sprintf(`$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$taskName = %s
$taskPath = '\'
$executable = %s
function Remove-ProjectConnectorTask {
  $task = Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1
  if ($null -eq $task) { return }
  Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
}
Remove-ProjectConnectorTask
try {
  if (-not [System.IO.File]::Exists($executable)) {
    throw 'The Project CLI executable does not exist.'
  }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $executable -Argument %s
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Description 'Keeps the authenticated native Project Space connector running.' -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
} catch {
  Remove-ProjectConnectorTask
  throw
}
`, powershellLiteral(connector.windowsTaskName), powershellLiteral(connector.executable), powershellLiteral(actionArguments))
}

func (connector *ServiceConnector) windowsStopScript() string {
	return fmt.Sprintf(`$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$taskName = %s
$taskPath = '\'
$task = Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1
if ($null -ne $task) {
  Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
}
exit 0
`, powershellLiteral(connector.windowsTaskName))
}

func nativeWindowsScheduledTaskName(sid string) string {
	digest := sha256.Sum256([]byte(strings.ToUpper(sid)))
	return fmt.Sprintf("%s~s%x", machineConnectorNativeWindowsTaskPrefix, digest[:8])
}

func validWindowsSID(value string) bool {
	if len(value) < 5 || len(value) > 184 || !strings.HasPrefix(strings.ToUpper(value), "S-") {
		return false
	}
	for _, character := range value[2:] {
		if character != '-' && (character < '0' || character > '9') {
			return false
		}
	}
	return !strings.Contains(value, "--") && value[len(value)-1] != '-'
}
