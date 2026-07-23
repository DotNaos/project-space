import { resolve } from 'node:path';

import { createLocalProjectSpaceBackend } from './local-project-space-backend';
import { reconcileProjectServeSessions } from './local-project-cli-client';
import { createConfiguredMachineConnectionRuntime } from './machine-connection-runtime';
import { resolveProjectConnectorTargets } from './project-connector-config';
import { readAndStartAuthenticatedProjectConnectorRuntime } from './project-connector-runtime';
import { createProjectSpaceServer } from './project-space-http';
import { startProjectConnectorWebSocket } from './project-connector-websocket';
import { connectorRuntimeRecord } from './connector-build-info';

const version = connectorRuntimeRecord().version;
const command = process.argv[2] ?? 'serve';

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`Project Space Connector ${version}

Usage:
  project-space-connector [serve]
  project-space-connector --version

Environment:
  PROJECT_SPACE_HOST  Host to bind. Defaults to 127.0.0.1.
  PROJECT_SPACE_PORT  Port to bind. Defaults to 4173.
  PROJECT_CONNECTOR_CONFIG  Connector hub config path. Defaults to ~/.config/project-space/connector.json.
  PROJECT_CONNECTOR_HUBS  Optional comma-separated or JSON hub list for one-off runs.
  CLERK_SECRET_KEY  Clerk secret key for Project Space login.
  PROJECT_SPACE_ALLOWED_EMAILS  Optional comma-separated Clerk email allowlist.
  PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET  Independent secret for public machine enrollment limits.
  PROJECT_SPACE_PUBLIC_ORIGIN  Public HTTPS origin used for machine approval links.
  PROJECT_SPACE_PREVIEW_MODE=1  Accept only trusted Preview gateway identity assertions.
  PROJECT_SPACE_PREVIEW_GATEWAY_SECRET  PR-scoped key used to verify Preview assertions.
  GITHUB_OAUTH_CLIENT_ID  GitHub OAuth app client ID for repository connection.
  PROJECT_SPACE_AUTH_DISABLED=1  Disable login protection for trusted local debugging only.

Configure the machine with:
  project connector setup

After starting the connector, open:
  https://projects.os-home.net

For remote browser access from your tailnet, expose it with:
  tailscale serve --bg --yes 4173
`);
  process.exit(0);
}

if (command === '--version' || command === '-v' || command === 'version') {
  console.log(version);
  process.exit(0);
}

if (command !== 'serve') {
  console.error(`Unknown command: ${command}`);
  console.error('Run project-space-connector --help for usage.');
  process.exit(1);
}

const authenticatedRuntime = await readAndStartAuthenticatedProjectConnectorRuntime();

if (authenticatedRuntime) {
  const runtime = authenticatedRuntime;
  let stopping = false;
  function stopAuthenticatedRuntime() {
    if (stopping) return;
    stopping = true;
    try {
      runtime.close();
    } finally {
      process.exit(0);
    }
  }

  process.once('SIGINT', stopAuthenticatedRuntime);
  process.once('SIGTERM', stopAuthenticatedRuntime);
  console.log('Project Space authenticated machine connector running.');
} else {
  const port = Number(process.env.PORT ?? process.env.PROJECT_SPACE_PORT ?? 4173);
  const host = process.env.PROJECT_SPACE_HOST ?? '127.0.0.1';
  const staticRoot = resolve(process.cwd(), 'dist/renderer');
  if (resolveProjectConnectorTargets().length > 0) {
    await reconcileProjectServeSessions();
  }
  const backend = createLocalProjectSpaceBackend();
  const machineConnectionRuntime = await createConfiguredMachineConnectionRuntime();
  const server = await createProjectSpaceServer({
    backend,
    host,
    machineConnectionRuntime: machineConnectionRuntime ?? undefined,
    port,
    staticRoot
  });
  const bridge = startProjectConnectorWebSocket({ backend });
  let stopping = false;

  function shutdown() {
    if (stopping) return;
    stopping = true;
    bridge.close();
    void server.close().finally(() => {
      process.exit(0);
    });
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.log(`Project Space fullstack server running at ${server.origin}`);
}
