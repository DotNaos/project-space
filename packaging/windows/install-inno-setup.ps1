[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$DestinationDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$version = '6.7.3'
$downloadUrl = 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'
$expectedSha256 = '9C73C3BAE7ED48D44112A0F48E66742C00090BDB5BEF71D9D3C056C66E97B732'
$resolvedDestination = [System.IO.Path]::GetFullPath($DestinationDirectory)
$compilerPath = Join-Path $resolvedDestination 'ISCC.exe'
$downloadPath = Join-Path ([System.IO.Path]::GetTempPath()) ('innosetup-' + [System.Guid]::NewGuid().ToString('N') + '.exe')

try {
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $downloadPath
  $actualSha256 = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash
  if (-not [System.String]::Equals($actualSha256, $expectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Inno Setup download checksum mismatch: expected $expectedSha256, got $actualSha256."
  }

  New-Item -ItemType Directory -Path $resolvedDestination -Force | Out-Null
  $installer = Start-Process -FilePath $downloadPath -ArgumentList @(
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/SP-',
    ('/DIR="' + $resolvedDestination + '"')
  ) -PassThru -Wait
  if ($installer.ExitCode -ne 0) {
    throw "Inno Setup $version installation failed with exit code $($installer.ExitCode)."
  }
  if (-not [System.IO.File]::Exists($compilerPath)) {
    throw "Inno Setup $version did not install ISCC.exe at $compilerPath."
  }

  Write-Output $compilerPath
}
finally {
  if ([System.IO.File]::Exists($downloadPath)) {
    Remove-Item -LiteralPath $downloadPath -Force
  }
}
