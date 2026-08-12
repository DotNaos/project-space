[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop

$prefixes = @(
  'Project Space Native Machine Connector Supervisor~s',
  'Project Space Machine Connector Supervisor~d'
)

$tasks = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object {
  $name = $_.TaskName
  @($prefixes | Where-Object { $name.StartsWith($_, [System.StringComparison]::Ordinal) }).Count -gt 0
})

foreach ($task in $tasks) {
  Stop-ScheduledTask -TaskPath '\' -TaskName $task.TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath '\' -TaskName $task.TaskName -Confirm:$false -ErrorAction Stop
}
