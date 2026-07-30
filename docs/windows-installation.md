# Install Project on Windows

Project runs natively on 64-bit Windows 10 and Windows 11. The installer is per-user, does not need administrator access, and installs both `project.exe` and `project-space-connector.exe` in `%LOCALAPPDATA%\Programs\Project Space`.

## Distribution policy

The Windows package is currently for Project Space operators and their approved machines only. It depends on the private Project Space backend and is not published in the official WinGet community catalog.

Do not submit the generated `DotNaos.Project` manifests to `microsoft/winget-pkgs` unless public distribution is approved as a separate product decision. Public distribution should wait until external or self-hosted use, installer signing, and public support expectations are ready.

The release workflow still creates an installer and WinGet manifests so operators can validate and install an approved release locally. Obtain those files from the Project Space release location shared by the operator.

## Install an approved operator release

Install the approved Windows installer from PowerShell:

```powershell
.\project-space-machine-tools-windows-x64-setup.exe /VERYSILENT /NORESTART
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

Installation, machine connection, status, diagnostics, and disconnection work directly in native Windows PowerShell. Project runtime commands still depend on Linux process behavior, so `project run`, `project prepare`, `project serve`, and their status, list, reconcile, and stop commands must run inside the selected Linux distribution on WSL. Use `wsl.exe --list --quiet` to find its exact distribution name.

For example:

```powershell
wsl.exe --distribution <distribution> -- project run test
wsl.exe --distribution <distribution> -- project prepare
wsl.exe --distribution <distribution> -- project serve
```

Replace `<distribution>` with the exact name reported by WSL. The WinGet package does not install WSL or install Project inside an existing WSL distribution. Install the Linux Project CLI separately inside that distribution before using those runtime commands. The native Windows connector and the WSL runtime are independent; installing or stopping one does not silently replace or remove the other.

## Upgrade

Check the signed stable release from PowerShell with:

```powershell
project self-update --check
project self-update --format json
```

The command verifies the signed manifest and prints the exact approved
installer URL, but it does not replace a running `project.exe`. Download that
installer and run the same installation command again. This explicit boundary
avoids an unsafe partial replacement of the CLI and connector.

The installer stops the existing connector before replacing either executable. It starts the connector again only when a machine credential already exists. The stable installation path means the Scheduled Task continues to point at the same `project.exe` across upgrades.

This release does not install a background updater and is not included in public `winget upgrade --all` results.

## Disconnect or uninstall

Disconnect explicitly when you still want to keep the CLI:

```powershell
project disconnect
```

Remove the package through Windows Settings, or with:

```powershell
winget uninstall --id DotNaos.Project --exact
```

Uninstall first attempts the normal backend revocation. Whether or not that online step succeeds, it then removes the local Scheduled Task and the complete DPAPI-protected machine identity before deleting the programs. If the computer is offline during uninstall, also remove that machine from Project Space when you are next online so the server-side credential is revoked.

## Validate or install an operator release with WinGet

Each GitHub release contains the installer, `SHA256SUMS.txt`, and the three rendered WinGet manifests. On a test machine, enable local manifests once:

```powershell
winget settings --enable LocalManifestFiles
```

From a checkout containing the rendered release manifests, validate and install them with:

```powershell
$manifest = '.\dist\winget\manifests\d\DotNaos\Project\0.4.43'
winget validate $manifest
winget install --manifest $manifest --accept-package-agreements --accept-source-agreements
```

The installer can also be exercised directly:

```powershell
.\project-space-machine-tools-windows-x64-setup.exe /VERYSILENT /NORESTART
```

Use a normal user PowerShell 5.1 or newer for these checks. No secret should be supplied through an installer argument, environment variable, or log.

## Future public WinGet publication

The release workflow renders a submission-ready directory at:

```text
manifests/d/DotNaos/Project/<version>
```

Keep this directory as an internal release artifact. It makes validation and local-manifest installation reproducible without publishing the package in the public catalog.

Publishing a future version to the official WinGet community repository requires a new explicit decision. Before submitting it, confirm that the CLI is useful without access to the private Project Space backend, that the installer is signed, and that public support and documentation are ready.
