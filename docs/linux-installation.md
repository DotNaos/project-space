# Linux x64 installation

Project Space publishes a pinned Linux x64 machine-tools bundle for Ubuntu and
WSL. The bundle contains the Project CLI, Codex host, and checksum-pinned
runtime assets for managed Workspace Runtimes. It does not
contain a login, token, machine credential, or Tailscale key.

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
stores the Project CLI and Codex host in a versioned directory and atomically
switches one `current` pointer in `~/.local/bin`. It is a per-user install and
refuses to run as root. No credential is accepted through installer arguments,
environment variables, or logs.

The Workspace Runtime uses only the Codex executable inside that same signed,
versioned release directory. The installer does not expose Codex through a
convenience symlink, edit `PATH` for Codex, run an upstream installer, or use
administrator privileges. The release build downloads one fixed official
OpenAI Codex archive, license, and notice, verifies their pinned checksums and
exact version, and then covers the resulting files with the Project Space
release manifest and archive checksums.

If `~/.local/bin` is not already on `PATH`, add it through the normal shell
profile for that user. Re-running the installer for an approved newer release
replaces the Project CLI and Codex host at the same stable paths and switches
the private managed Codex runtime with the same release pointer. It does not
start or reconnect a permanent service.

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
SHA-256 checksum before the existing installer can switch the CLI and Codex
host together. There is no background updater.

## Bootstrap an Environment Runtime

Register the machine once. This stores an owner-bound Machine Credential but
does not install or start a background Connector:

```sh
project connect
```

List the exact Environment Instances available to the current account:

```sh
project environment instance list
```

From the managed worktree, let Project detect the Workspace identity, commit,
resolved Runtime plan, version, mode, owner, and unambiguous Environment
Instance, then create the generation identity:

```sh
project environment bootstrap
```

If the Workspace can run in more than one Environment, pass the exact
Environment Instance reference: `project environment bootstrap <environment>`.
See the [Environment bootstrap guide](https://projects.os-home.net/docs/environments/setup)
for advanced explicit values used by automation.

The bootstrap is scoped to that Environment and generation. It starts no
permanent Connector and does not accept a Connector ID as a substitute for an
Environment Instance. Use [Workspace runtimes](./workspace-runtimes.md) for
inspect, suspend, resume, stop, reconcile, and cleanup.

## Tailscale in WSL

For a WSL-owned development endpoint, install and enroll Tailscale inside that
same Ubuntu distribution using the approved tailnet process. Do not enable
Funnel or publish a retired Connector endpoint. Project-managed development
servers remain private to the tailnet and use the existing narrowly owned
route lifecycle.

Tailscale is intentionally not included in the machine-tools archive. Its
installation and device approval follow the tailnet administrator's policy and
must not reuse a Project Space credential.

## Release contents

The release workflow builds Linux executables from the tagged source, embeds
the package version and production Project Space URL in the CLI, creates the
deterministic archive, and publishes the archive-level SHA-256 file. The bundle
also contains `SHA256SUMS.txt` for the extracted files and the pinned upstream
Codex license, notice, and version evidence. The release job starts the exact
Codex App Server and reads its structured account state before publishing the
bundle.
