[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$renderer = Join-Path $PSScriptRoot 'render-winget-manifests.ps1'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('project-space-winget-' + [System.Guid]::NewGuid().ToString('N'))
$version = '0.4.48'
$url = 'https://github.com/DotNaos/project-space/releases/download/v0.4.48/project-space-machine-tools-windows-x64-setup.exe'
$sha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
$installerScriptPath = Join-Path $PSScriptRoot 'project-space.iss'
$innoInstallScriptPath = Join-Path $PSScriptRoot 'install-inno-setup.ps1'

function Remove-ExactPathEntry(
  [string]$PathValue,
  [string]$Entry
) {
  $segments = [System.Text.RegularExpressions.Regex]::Split($PathValue, ';')
  $keptSegments = @(
    $segments | Where-Object {
      -not [System.String]::Equals($_, $Entry, [System.StringComparison]::OrdinalIgnoreCase)
    }
  )
  return [System.String]::Join(';', [string[]]$keptSegments)
}

function Assert-RendererRejects(
  [string]$InvalidVersion,
  [string]$InvalidUrl,
  [string]$InvalidSha256,
  [string]$Message
) {
  $rejected = $false
  try {
    & $renderer -Version $InvalidVersion -InstallerUrl $InvalidUrl -InstallerSha256 $InvalidSha256 -OutputDirectory (Join-Path $temporaryRoot 'invalid') | Out-Null
  }
  catch {
    $rejected = $true
  }
  if (-not $rejected) {
    throw $Message
  }
}

try {
  $pathEntry = 'C:\Users\Example\AppData\Local\Programs\Project Space'
  $pathRemovalCases = @(
    @{
      Name = 'keeps unrelated empty segments'
      Input = 'C:\One;;C:\Two;'
      Expected = 'C:\One;;C:\Two;'
    },
    @{
      Name = 'removes only the middle Project entry'
      Input = "C:\One;;$pathEntry;;C:\Two"
      Expected = 'C:\One;;;C:\Two'
    },
    @{
      Name = 'preserves unrelated whitespace and trailing empty segment'
      Input = "$pathEntry; C:\Keep ;"
      Expected = ' C:\Keep ;'
    },
    @{
      Name = 'preserves leading and trailing empty segments'
      Input = ";$pathEntry;"
      Expected = ';'
    },
    @{
      Name = 'matches Windows paths case-insensitively'
      Input = 'C:\USERS\EXAMPLE\APPDATA\LOCAL\PROGRAMS\PROJECT SPACE;C:\Keep'
      Expected = 'C:\Keep'
    },
    @{
      Name = 'removes repeated exact entries without matching prefixes'
      Input = "$pathEntry-ish;$pathEntry;$pathEntry"
      Expected = "$pathEntry-ish"
    }
  )
  foreach ($case in $pathRemovalCases) {
    $actual = Remove-ExactPathEntry -PathValue $case.Input -Entry $pathEntry
    if ($actual -cne $case.Expected) {
      throw "PATH removal failed $($case.Name): expected '$($case.Expected)', got '$actual'."
    }
  }

  $installerScript = [System.IO.File]::ReadAllText($installerScriptPath)
  foreach ($requiredFragment in @(
    'function PathWithoutEntry',
    'UninstallDisplayName={#MyAppName}',
    'function PreservePreviousInstallation(): Boolean;',
    'function RestorePreviousFiles(): Boolean;',
    'procedure StartInstalledConnectorOrRollback();',
    "if not RunInstalledProject('connector service start-if-connected', ResultCode) then",
    "if not RunInstalledProjectSuccessfully('connector service stop') then",
    "if not RunInstalledProjectSuccessfully('connector service start-if-connected') then",
    'if ResultCode <> 0 then',
    'The previous Project Space machine tools were restored, but their connector could not be restarted. Manual recovery is required.',
    'The new Project Space connector failed its authenticated reconnect check. The previous machine tools were restored and restarted.',
    'if Uppercase(Item) <> Uppercase(Entry) then',
    'if HasOutputSegment then',
    'NewPath := PathWithoutEntry(CurrentPath, Entry)',
    "if not FileExists(ExpandConstant('{app}\project.exe')) then",
    "if not RunInstalledProject('connector service uninstall', ResultCode) then",
    "RaiseException('Project Space could not remove its local connector state.')"
  )) {
    if (-not $installerScript.Contains($requiredFragment)) {
      throw "Installer PATH removal contract is missing: $requiredFragment"
    }
  }
  if ($installerScript.Contains('Item := Trim(Item)')) {
    throw 'Installer PATH removal must not trim unrelated PATH segments.'
  }
  if ($installerScript.Contains("RunInstalledProject('disconnect'")) {
    throw 'Installer uninstall must keep revocation and purge inside one locked CLI command.'
  }
  if ($installerScript.Contains('[Run]')) {
    throw 'Installer connector startup must remain in checked Pascal code, not an unchecked [Run] entry.'
  }

  $innoInstallScript = [System.IO.File]::ReadAllText($innoInstallScriptPath)
  foreach ($requiredFragment in @(
    "`$version = '6.7.3'",
    'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe',
    "`$expectedSha256 = '9C73C3BAE7ED48D44112A0F48E66742C00090BDB5BEF71D9D3C056C66E97B732'",
    'Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256'
  )) {
    if (-not $innoInstallScript.Contains($requiredFragment)) {
      throw "Pinned Inno Setup install contract is missing: $requiredFragment"
    }
  }

  $firstRoot = Join-Path $temporaryRoot 'first'
  $secondRoot = Join-Path $temporaryRoot 'second'
  $firstManifestDirectory = & $renderer -Version $version -InstallerUrl $url -InstallerSha256 $sha256 -OutputDirectory $firstRoot
  $secondManifestDirectory = & $renderer -Version $version -InstallerUrl $url -InstallerSha256 ($sha256.ToUpperInvariant()) -OutputDirectory $secondRoot

  $firstFiles = @(Get-ChildItem -LiteralPath $firstManifestDirectory -File | Sort-Object Name)
  $secondFiles = @(Get-ChildItem -LiteralPath $secondManifestDirectory -File | Sort-Object Name)
  if (($firstFiles.Count -ne 3) -or ($secondFiles.Count -ne 3)) {
    throw 'The renderer must emit exactly three WinGet manifests.'
  }

  for ($index = 0; $index -lt $firstFiles.Count; $index++) {
    if ($firstFiles[$index].Name -ne $secondFiles[$index].Name) {
      throw 'The renderer emitted different manifest names for the same input.'
    }
    $firstHash = (Get-FileHash -LiteralPath $firstFiles[$index].FullName -Algorithm SHA256).Hash
    $secondHash = (Get-FileHash -LiteralPath $secondFiles[$index].FullName -Algorithm SHA256).Hash
    if ($firstHash -ne $secondHash) {
      throw "Manifest rendering is not deterministic: $($firstFiles[$index].Name)"
    }
    $content = [System.IO.File]::ReadAllText($firstFiles[$index].FullName)
    if ($content.Contains('{{')) {
      throw "Rendered manifest contains an unresolved placeholder: $($firstFiles[$index].Name)"
    }
  }

  $installerManifest = [System.IO.File]::ReadAllText((Join-Path $firstManifestDirectory 'DotNaos.Project.installer.yaml'))
  if (-not $installerManifest.Contains($sha256.ToUpperInvariant())) {
    throw 'The rendered installer manifest does not contain the normalized SHA-256.'
  }
  foreach ($requiredFragment in @(
    "ProductCode: '{D0B7D247-B537-41B4-9F36-73C61CB16B54}_is1'",
    'DisplayName: Project',
    "DefaultInstallLocation: '%LocalAppData%\Programs\Project Space'"
  )) {
    if (-not $installerManifest.Contains($requiredFragment)) {
      throw "The rendered installer manifest lacks package detection metadata: $requiredFragment"
    }
  }

  Assert-RendererRejects 'v0.4.1' $url $sha256 'The renderer accepted a version with a v prefix.'
  Assert-RendererRejects $version 'http://example.com/project-space-machine-tools-windows-x64-setup.exe' $sha256 'The renderer accepted an insecure installer URL.'
  Assert-RendererRejects $version $url 'not-a-sha256' 'The renderer accepted an invalid SHA-256.'

  Write-Output 'Windows release packaging checks passed.'
}
finally {
  if ([System.IO.Directory]::Exists($temporaryRoot)) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
