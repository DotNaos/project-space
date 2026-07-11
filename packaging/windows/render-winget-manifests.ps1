[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$InstallerUrl,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Fa-f]{64}$')]
  [string]$InstallerSha256,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$OutputDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$parsedUrl = $null
if (-not [System.Uri]::TryCreate($InstallerUrl, [System.UriKind]::Absolute, [ref]$parsedUrl)) {
  throw 'InstallerUrl must be an absolute URL.'
}
if ($parsedUrl.Scheme -ne 'https') {
  throw 'InstallerUrl must use HTTPS.'
}
if (($parsedUrl.UserInfo -ne '') -or ($parsedUrl.Query -ne '') -or ($parsedUrl.Fragment -ne '')) {
  throw 'InstallerUrl must not contain credentials, a query, or a fragment.'
}
if (-not $parsedUrl.AbsolutePath.EndsWith('/project-space-machine-tools-windows-x64-setup.exe')) {
  throw 'InstallerUrl must point to project-space-machine-tools-windows-x64-setup.exe.'
}

$templateDirectory = Join-Path $PSScriptRoot 'winget\templates'
$templateNames = @(
  'DotNaos.Project.yaml',
  'DotNaos.Project.installer.yaml',
  'DotNaos.Project.locale.en-US.yaml'
)

foreach ($templateName in $templateNames) {
  $templatePath = Join-Path $templateDirectory $templateName
  if (-not [System.IO.File]::Exists($templatePath)) {
    throw "Required WinGet template is missing: $templateName"
  }
}

$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$manifestDirectory = Join-Path $resolvedOutputDirectory ("manifests\d\DotNaos\Project\{0}" -f $Version)
if ([System.IO.Directory]::Exists($manifestDirectory)) {
  Remove-Item -LiteralPath $manifestDirectory -Recurse -Force
}
[System.IO.Directory]::CreateDirectory($manifestDirectory) | Out-Null

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$normalizedSha256 = $InstallerSha256.ToUpperInvariant()
foreach ($templateName in $templateNames) {
  $templatePath = Join-Path $templateDirectory $templateName
  $rendered = [System.IO.File]::ReadAllText($templatePath)
  $rendered = $rendered -replace "`r`n?", "`n"
  $rendered = $rendered.Replace('{{VERSION}}', $Version)
  $rendered = $rendered.Replace('{{INSTALLER_URL}}', $parsedUrl.AbsoluteUri)
  $rendered = $rendered.Replace('{{INSTALLER_SHA256}}', $normalizedSha256)
  if ($rendered.Contains('{{')) {
    throw "Unresolved placeholder in rendered manifest: $templateName"
  }
  if (-not $rendered.EndsWith("`n")) {
    $rendered = $rendered + "`n"
  }
  [System.IO.File]::WriteAllText((Join-Path $manifestDirectory $templateName), $rendered, $utf8WithoutBom)
}

Write-Output $manifestDirectory
