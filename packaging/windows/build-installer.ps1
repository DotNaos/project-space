[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SourceDirectory,

  [string]$CompilerPath = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$resolvedSourceDirectory = [System.IO.Path]::GetFullPath($SourceDirectory)
foreach ($binaryName in @('project.exe', 'project-codex-host.exe')) {
  $binaryPath = Join-Path $resolvedSourceDirectory $binaryName
  if (-not [System.IO.File]::Exists($binaryPath)) {
    throw "Required Windows release binary is missing: $binaryPath"
  }
}
$retirementScript = Join-Path $PSScriptRoot 'retire-connector.ps1'
if (-not [System.IO.File]::Exists($retirementScript)) {
  throw "The Connector retirement script is missing: $retirementScript"
}
Copy-Item -LiteralPath $retirementScript -Destination (Join-Path $resolvedSourceDirectory 'retire-connector.ps1') -Force

if ($CompilerPath -eq '') {
  $compilerCandidates = @()
  if ($env:LOCALAPPDATA) {
    $compilerCandidates += Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
  }
  $programFilesX86 = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)
  if ($programFilesX86) {
    $compilerCandidates += Join-Path $programFilesX86 'Inno Setup 6\ISCC.exe'
  }
  $compilerCommand = Get-Command 'ISCC.exe' -ErrorAction SilentlyContinue
  if ($null -ne $compilerCommand) {
    $compilerCandidates += $compilerCommand.Source
  }
  foreach ($candidate in $compilerCandidates) {
    if ([System.IO.File]::Exists($candidate)) {
      $CompilerPath = $candidate
      break
    }
  }
}

if (($CompilerPath -eq '') -or (-not [System.IO.File]::Exists($CompilerPath))) {
  throw 'Inno Setup 6 compiler was not found.'
}

$installerScript = Join-Path $PSScriptRoot 'project-space.iss'
$compilerOutput = @(& $CompilerPath "/DMyAppVersion=$Version" "/DSourceDirectory=$resolvedSourceDirectory" $installerScript 2>&1)
$compilerExitCode = $LASTEXITCODE
foreach ($line in $compilerOutput) {
  Write-Host $line
}
if ($compilerExitCode -ne 0) {
  throw "Inno Setup failed with exit code $compilerExitCode."
}

$installerPath = Join-Path $resolvedSourceDirectory 'project-space-machine-tools-windows-x64-setup.exe'
if (-not [System.IO.File]::Exists($installerPath)) {
  throw "Inno Setup did not create the expected installer: $installerPath"
}

Write-Output $installerPath
