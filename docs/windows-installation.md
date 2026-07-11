# Install Project on Windows

Project runs natively on 64-bit Windows 10 and Windows 11. The installer is per-user, does not need administrator access, and installs both `project.exe` and `project-space-connector.exe` in `%LOCALAPPDATA%\Programs\Project Space`.

## Install with WinGet

After `DotNaos.Project` has been accepted into the public WinGet community repository, install it from PowerShell with:

```powershell
winget install --id DotNaos.Project --exact
```

Open a new terminal after the first installation so it sees the updated user `PATH`. Then connect the machine:

```powershell
project connect
```

`project connect` opens the Project Space approval page in the browser. The installer does not include a login, token, or machine credential. After approval, Project stores the complete machine identity in a current-user DPAPI-protected file under LocalAppData and keeps the connector running through a per-user Scheduled Task. The state remains encrypted at rest and works from both normal PowerShell and Windows OpenSSH sessions.

Useful checks are:

```powershell
project status
project doctor
```

## Native Windows and WSL boundary

Installation, machine connection, status, diagnostics, and disconnection work directly in native Windows PowerShell. Project runtime commands still depend on Linux process behavior, so `project run`, `project serve`, and the `project serve reconcile`, `status`, and `stop` commands must run inside Ubuntu on WSL.

For example:

```powershell
wsl.exe --distribution Ubuntu -- project run test
wsl.exe --distribution Ubuntu -- project serve
```

The WinGet package does not install WSL or install Project inside an existing WSL distribution. Install the Linux Project CLI separately inside Ubuntu before using those runtime commands. The native Windows connector and the WSL runtime are independent; installing or stopping one does not silently replace or remove the other.

## Upgrade

```powershell
winget upgrade --id DotNaos.Project --exact
```

The installer stops the existing connector before replacing either executable. It starts the connector again only when a machine credential already exists. The stable installation path means the Scheduled Task continues to point at the same `project.exe` across upgrades.

WinGet is the update mechanism, but this release does not install a separate background updater. Run the command above, or include Project in your normal `winget upgrade --all` routine.

## Disconnect or uninstall

Disconnect explicitly when you still want to keep the CLI:

```powershell
project disconnect
```

Remove the package with:

```powershell
winget uninstall --id DotNaos.Project --exact
```

Uninstall first attempts the normal backend revocation. Whether or not that online step succeeds, it then removes the local Scheduled Task and the complete DPAPI-protected machine identity before deleting the programs. If the computer is offline during uninstall, also remove that machine from Project Space when you are next online so the server-side credential is revoked.

## Test a release before community publication

Each GitHub release contains the installer, `SHA256SUMS.txt`, and the three rendered WinGet manifests. On a test machine, enable local manifests once:

```powershell
winget settings --enable LocalManifestFiles
```

From a checkout containing the rendered release manifests, validate and install them with:

```powershell
$manifest = '.\dist\winget\manifests\d\DotNaos\Project\0.3.1'
winget validate $manifest
winget install --manifest $manifest --accept-package-agreements --accept-source-agreements
```

The installer can also be exercised directly:

```powershell
.\project-space-machine-tools-windows-x64-setup.exe /VERYSILENT /NORESTART
```

Use a normal user PowerShell 5.1 or newer for these checks. No secret should be supplied through an installer argument, environment variable, or log.

## Prepare a WinGet community submission

The release workflow renders a submission-ready directory at:

```text
manifests/d/DotNaos/Project/<version>
```

Copy that directory into a fork of `microsoft/winget-pkgs`, run `winget validate` and a Windows Sandbox install test, then submit it to the community repository. The public `winget install --id DotNaos.Project --exact` command becomes available after that pull request is accepted.
