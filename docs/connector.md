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

## Install with Homebrew

```bash
brew tap DotNaos/project-space https://github.com/DotNaos/project-space.git
brew install project-space-connector
brew services start project-space-connector
```

Check the service:

```bash
project-space-connector --version
curl http://127.0.0.1:4173/api/health
```

## Manual Download

Download the latest release from:

```text
https://github.com/DotNaos/project-space/releases/latest
```

For Apple Silicon macOS:

```bash
curl -L https://github.com/DotNaos/project-space/releases/latest/download/project-space-connector-darwin-arm64.tar.gz -o project-space-connector.tar.gz
tar -xzf project-space-connector.tar.gz
./project-space-connector
```

## Configure the Connector

The preferred setup path is the Project CLI:

```bash
project connector setup
project connector install
project connector status
```

`project connector setup` writes the connector configuration. `project connector install`
also installs and starts a macOS LaunchAgent that survives terminal closure and login restarts.
Both commands configure one connector process for the remote Project Space server and the local
development server at the same time.

The installer stores the registration token in a private, non-versioned file next to the connector
configuration. The LaunchAgent and its command line contain only the path to that file, never the
token itself.

The connector reads these environment variables:

```bash
PROJECT_SPACE_HOST=127.0.0.1
PROJECT_SPACE_PORT=4173
PROJECT_CONNECTOR_CONFIG=~/.config/project-space/connector.json
PROJECT_CONNECTOR_SERVICE_NAME=project-space-connector
PROJECT_CONNECTOR_REGISTRATION_TOKEN=<from 1Password or launchd env>
PROJECT_SPACE_PRIVATE_VPS_BASE_URL=https://your-private-vps-platform-api
PROJECT_SPACE_CONNECTOR_ORIGIN=https://your-machine.tailnet.ts.net
```

Defaults:

- `PROJECT_SPACE_HOST` defaults to `127.0.0.1`.
- `PROJECT_SPACE_PORT` defaults to `4173`.
- `PROJECT_CONNECTOR_CONFIG` points to the list of hubs where this connector publishes itself.
- `PROJECT_CONNECTOR_SERVICE_NAME` is the service label shown on machine cards.
- `PROJECT_CONNECTOR_REGISTRATION_TOKEN` is read from the environment, not from the config file.
- `PROJECT_SPACE_PRIVATE_VPS_BASE_URL` is optional until deployments/backups are wired to the VPS platform.
- `PROJECT_SPACE_CONNECTOR_ORIGIN` is optional metadata shown in the UI.

## Expose Through Tailscale

The hosted UI should use a Tailscale HTTPS endpoint, not plain localhost.

```bash
tailscale status
tailscale serve --bg --yes 4173
tailscale serve status --json
```

Then open Project Space with the connector URL:

```text
https://projects.os-home.net/?projectSpaceApi=https://your-machine.tailnet.ts.net
```

## Use the Connector

Once connected, Project Space can show:

- projects discovered under `~/projects`
- template adherence validation (`project validate`) with per-rule results for a selected project
- Git status, diffs, staging, unstaging, and commits
- terminal command execution inside a selected project or worktree
- Codex CLI/app status
- Tailscale status
- machines from `/Users/oli/projects/machines`
- private VPS platform deployments and backups when `PROJECT_SPACE_PRIVATE_VPS_BASE_URL` is set

## Troubleshooting Path

If the UI shows no projects:

1. Check that the connector is running.
2. Open `http://127.0.0.1:4173/api/health` locally.
3. Check Tailscale Serve with `tailscale serve status --json`.
4. Open the hosted UI with `?projectSpaceApi=<tailscale-https-url>`.
5. If deployments/backups are offline, set `PROJECT_SPACE_PRIVATE_VPS_BASE_URL`.
