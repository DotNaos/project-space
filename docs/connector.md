# Project Space Connector

The Project Space Connector runs inside trusted compute Environments and gives the hosted Project Space UI a safe
way to work with local projects, Git repositories, terminal commands, Codex, Tailscale, deployments,
and backups.

Project Space distinguishes Platforms, optional Hosts, Environments, and
Connector installations. The Connector is one authenticated installation inside
exactly one Environment; it is not a physical machine or an Environment by
itself. See [Compute Platforms, Hosts, and Environments](./compute-environments.md)
for the canonical hierarchy, identity rules, resource ownership, and staged
migration from the historical machine-shaped API.

The web UI is deployed at:

```text
https://projects.os-home.net
```

The connector keeps local access local. The hosted UI does not receive direct filesystem access; it
talks to the connector endpoint that you explicitly run on a trusted machine.

## Install from Project Space

Open Machines in the hosted app and explicitly generate a managed installer.
The command pins one exact release archive and checksum. After installing the
Project CLI and connector together, it runs `project connect`, which creates the
historical connector key locally and opens the short-lived signed-in approval
page. Enrollment creates the connector credential and its required bootstrap
Environment association in one database transaction. The key remains exposed
as `machineId` for API compatibility; it must not be interpreted as a Host or
Environment identity.

The installer downloads one pinned, checksum-verified macOS arm64 bundle. It
installs both `project-space-connector` and the `project` CLI under
`~/.local/bin`, then starts the existing protected per-user supervisor after
approval. It never downloads a mutable `latest` asset. Reinstalling an existing
managed connector preserves its identity and settings. A verified Homebrew
connector is migrated only through the explicit `self-update --migrate-managed`
flow; the normal installer never silently changes package ownership.

Before enabling account installers for a deployment, publish the bundle and its
signed `project-space-release-manifest.json`. The server accepts only one exact
release and verifies that manifest with the dedicated release public key:

```text
PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID=v0.x.y
PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64=<base64-encoded Ed25519 public key>
```

The production deployment derives the approved release ID from the deployed
Project Space version. The verified manifest supplies the exact platform
archive and checksum; browser requests cannot supply a URL, path, package, or
platform selector.

Build the release archive with:

```bash
bun run build:machine-tools:macos-arm64
shasum -a 256 dist/macos-release/project-space-machine-tools-darwin-arm64-v0.x.y.tar.gz
```

The `project` Homebrew formula remains a supported way to build, install, and
update both the Project CLI and connector. The standalone
`project-space-connector` formula and its Homebrew service also remain supported
for connector-only delivery.

An existing Homebrew CLI can explicitly migrate to the signed managed pair:

```sh
project self-update --migrate-managed --check
project self-update --migrate-managed
```

The migration is opt-in and never runs during a normal Homebrew update or plain
`project self-update`. It leaves Homebrew files untouched, installs the exact
verified machine-tools release under `~/.local/bin`, preserves compatible
machine identity and credential state, quiesces the known Homebrew or Project
per-user connector service so it cannot compete with the managed service, and
succeeds only after the exact managed build authenticates and reconnects.

Managed macOS arm64 and Linux x64/WSL installations can later update the same
pair with `project self-update`. The command verifies an exact signed stable
release before prompting, then uses the existing installer to stop the
connector, atomically switch both tools, restart it, and roll back the pair if
startup fails. It preserves machine identity and credentials and never runs in
the background.

`project self-update --check` is read-only. JSON output never prompts and only
installs when it is explicitly combined with `--yes`. Homebrew copies continue
to update through Homebrew unless `--migrate-managed` is explicitly supplied
and are never overwritten; source-built copies remain unsupported. Native
Windows reports the
verified installer URL because a running `project.exe` cannot safely replace
itself and synchronously prove the final paired state.

## Configure the Connector

For the hosted multi-user app, copy the managed command from Project Space.
Each release bundle contains checksum-covered command and release-manifest
public keys. `project connect` generates the machine private key locally,
requires signed-in approval, stores the resulting credential outside the
repository, and starts the per-user supervisor. The browser never receives the
machine private key or an unrestricted command channel.

Do not copy arbitrary legacy connector state. The supported Homebrew migration
preserves the existing protected credential and pairing configuration only
across the verified known per-user service transition. Other legacy connectors
must be revoked or removed explicitly and enrolled again with `project connect`.

The connector reads these environment variables:

```bash
PROJECT_SPACE_HOST=127.0.0.1
PROJECT_SPACE_PORT=4173
PROJECT_CONNECTOR_CONFIG=~/.config/project-space/connector.json
PROJECT_CONNECTOR_SERVICE_NAME=project-space-connector
PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE=~/.config/project-space/connector-credential
PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY_FILE=~/.config/project-space/command-signing-public-key.pem
PROJECT_CLI_PATH=~/.local/bin/project
PROJECT_SPACE_PRIVATE_VPS_BASE_URL=https://your-private-vps-platform-api
PROJECT_SPACE_CONNECTOR_ORIGIN=https://your-machine.tailnet.ts.net
```

Defaults:

- `PROJECT_SPACE_HOST` defaults to `127.0.0.1`.
- `PROJECT_SPACE_PORT` defaults to `4173`.
- `PROJECT_CONNECTOR_CONFIG` points to the list of hubs where this connector publishes itself.
- `PROJECT_CONNECTOR_SERVICE_NAME` is the service label shown on machine cards.
- The credential and command public key are read from private files outside the repository.
- `PROJECT_CLI_PATH` pins the Project CLI that was verified and installed with the connector.
- `PROJECT_SPACE_PRIVATE_VPS_BASE_URL` is optional until deployments/backups are wired to the VPS platform.
- `PROJECT_SPACE_CONNECTOR_ORIGIN` is optional metadata shown in the UI.

Example generated configuration:

```json
{
  "machineId": "connector-00000000-0000-0000-0000-000000000000",
  "hubs": [
    {
      "name": "prod",
      "url": "https://projects.os-home.net",
      "registrationTokenFile": "~/.config/project-space/connector-credential",
      "commandGrantPublicKeyFile": "~/.config/project-space/command-signing-public-key.pem"
    }
  ]
}
```

The connector opens an outbound authenticated WebSocket to the hub. Its API
does not need a public or Tailscale Serve endpoint. The hub revalidates the
stored credential on registry refreshes and closes a revoked or expired
connection.

Machine kind, host names, SSH users, and network data reported by a connector
are display metadata, not trust signals. A connector registry can never select
execution on the hosted server or make that server initiate SSH. Supported
operations are routed back through the authenticated connector channel.

The connector reports a versioned, privacy-preserving Environment identity and
Resource Profile. Raw hardware, operating-system, container, and provider
identifiers are hashed locally and never leave their trust boundary; the server
derives the key again with the account ID before persistence. Native hosts use
best-effort SMBIOS evidence where available; WSL and Docker remain distinct
Environments; Codespaces and Kubernetes are provider-managed Platforms without
fictional Hosts. Evidence-poor legacy connectors receive an explicit **Needs
assignment** Environment rather than becoming unassigned.

## Worktree Development Servers

When a project defines `.project/scripts.yaml`, the browser submits only known
machine, project, and worktree IDs. The hub resolves the trusted path, verifies
the user's database membership, loads that user's run settings, signs a
short-lived Ed25519 grant, and sends a typed operation to the connector.

The connector runs `project serve` and exposes one exact raw Tailscale TCP port,
for example `http://100.80.135.9:44000/`. This is intentionally DNS-free because
MagicDNS is disabled. It never uses Funnel, resets Tailscale Serve, or removes a
route it did not create. The UI shows the URL only for a fresh, verified
`running` state.

Project Space authentication controls who can start, stop, and see the URL.
Network access is still governed by Tailscale ACLs: any tailnet principal
allowed to reach that machine and port can connect. Per-user network isolation
would require an authenticated proxy in a later version.

## Use the Connector

Once connected, Project Space can show:

- projects discovered under `~/projects`
- template adherence validation (`project validate`) with per-rule results for a selected project
- Git status, diffs, staging, unstaging, and commits
- terminal command execution inside a selected project or worktree
- Codex CLI/app status
- Tailscale status
- worktree development-server state and its verified Tailscale URL
- machines from `/Users/oli/projects/machines`
- private VPS platform deployments and backups when `PROJECT_SPACE_PRIVATE_VPS_BASE_URL` is set

## Troubleshooting Path

If the UI shows no projects:

1. Check that the connector is running.
2. Open `http://127.0.0.1:4173/api/health` locally.
3. Check the outbound connector registration in Project Space settings.
4. For a running worktree server, check `tailscale serve status --json`.
5. If deployments/backups are offline, set `PROJECT_SPACE_PRIVATE_VPS_BASE_URL`.
