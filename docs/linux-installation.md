# Linux x64 installation

Project Space publishes a pinned Linux x64 machine-tools bundle for Ubuntu and
WSL. The bundle contains the matching Project CLI and connector executables; it
does not contain a login, token, machine credential, or Tailscale key.

## Verify and install an approved release

Download both files for the approved version from the Project Space GitHub
release:

- `project-space-machine-tools-linux-x64-v<VERSION>.tar.gz`
- `project-space-machine-tools-linux-x64-v<VERSION>.tar.gz.sha256`

Verify the downloaded archive before extracting it:

```sh
sha256sum --check project-space-machine-tools-linux-x64-v<VERSION>.tar.gz.sha256
tar -xzf project-space-machine-tools-linux-x64-v<VERSION>.tar.gz
cd project-space-machine-tools-linux-x64-v<VERSION>
./install.sh
```

The installer independently verifies every file in the extracted bundle. It
stores each matching CLI and connector pair in a versioned directory and then
atomically switches one `current` pointer used by both commands in
`~/.local/bin`. It stops the existing connector before that switch, starts the
new connector afterward when this user is already connected, and restores the
previous pair if the new connector cannot start. It is a per-user install and
refuses to run as root. No credential is accepted through installer arguments,
environment variables, or logs.

If `~/.local/bin` is not already on `PATH`, add it through the normal shell
profile for that user. Re-running the installer for an approved newer release
replaces both executables at the same stable paths.

After the first managed installation, check or install the next signed stable
release with:

```sh
project self-update --check
project self-update
```

The interactive command defaults to no. Use `project self-update --yes` for an
explicit non-interactive install. `--format json` never prompts and remains
read-only unless combined with `--yes`. The updater never uses a mutable latest
download URL: it verifies the exact signed manifest, pinned archive size, and
SHA-256 checksum before the existing installer can switch the CLI and connector
together. There is no background updater.

## Connect the machine

After installation, sign in through the normal browser approval flow:

```sh
project connect
```

The Project CLI stores the approved per-user machine credential using its
existing protected Linux/WSL credential store. It starts only the bundled
sibling connector. Native Linux uses the existing private user systemd service;
WSL uses the existing narrowly named Windows Scheduled Task to keep that WSL
process alive. The service definition and process arguments do not contain the
credential.

Do not create a second connector supervisor around these commands. Disconnect
and revoke the endpoint through the Project CLI so its exact service and local
credential state are removed together.

## Tailscale in WSL

For a WSL-owned development endpoint, install and enroll Tailscale inside that
same Ubuntu distribution using the approved tailnet process. Do not enable
Funnel or publish the connector. Project-managed development servers remain
private to the tailnet and use the existing narrowly owned route lifecycle.

Tailscale is intentionally not included in the machine-tools archive. Its
installation and device approval follow the tailnet administrator's policy and
must not reuse a Project Space credential.

## Release contents

The release workflow builds Linux executables from the tagged source, embeds
the package version and production Project Space URL in the CLI, creates the
deterministic archive, and publishes the archive-level SHA-256 file. The bundle
also contains `SHA256SUMS.txt` for the extracted files.
