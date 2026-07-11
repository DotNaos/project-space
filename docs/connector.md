# Project Space Connector

The Project Space Connector runs on trusted machines and gives the hosted Project Space UI a safe
way to work with local projects, Git repositories, terminal commands, Codex, Tailscale, deployments,
and backups.

The web UI is deployed at:

```text
https://projects.os-home.net
```

The connector keeps local access local. The hosted UI does not receive direct filesystem access; it
talks to the connector endpoint that you explicitly run on a trusted machine.

## Install from Project Space

Open Settings in the hosted app and explicitly generate an account installer.
The command is valid for 15 minutes and is bound to both the signed-in account
and a server-assigned machine ID. Generating another unused command revokes the
previous pending enrollment.

The installer downloads one pinned, checksum-verified macOS arm64 bundle. It
installs both `project-space-connector` and the `project` CLI under
`~/.local/bin`, then starts a LaunchAgent with explicit binary and toolchain
paths. It never downloads a mutable `latest` asset.

Before enabling account installers for a deployment, publish the bundle and
configure its exact release metadata:

```text
PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION=v0.x.y
PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET=project-space-machine-tools-darwin-arm64.tar.gz
PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256=<64 lowercase hex characters>
```

Build the release archive with:

```bash
bun run build:machine-tools:macos-arm64
shasum -a 256 dist/project-space-machine-tools-darwin-arm64.tar.gz
```

Homebrew, Linux, Windows, and the final `project connect` enrollment flow are
being handled separately. This installer deliberately covers only the current
macOS connector needed by this feature.

## Configure the Connector

For the hosted multi-user app, copy the account-specific command from Project
Space settings. The installer creates a private credential file, installs the
hub command-signing public key, assigns an opaque `connector-<uuid>` machine ID,
and starts a macOS LaunchAgent. A newly generated installer replaces any local
legacy identity with its assigned machine ID. PostgreSQL verifies that exact ID
before it creates the account membership, then extends the bound credential for
normal connector operation.

Reinstall legacy connectors once through the account-specific command. The old
shared registration token is not accepted when database-backed enrollment is
configured.

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
