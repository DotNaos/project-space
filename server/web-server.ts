import { resolve } from 'node:path';

import { createLocalProjectSpaceBackend } from './local-project-space-backend';
import { createConfiguredMachineConnectionRuntime } from './machine-connection-runtime';
import { hasDedicatedGitHubOAuthTokenEncryptionKey } from './github-oauth-token-encryption';
import { createProjectSpaceServer } from './project-space-http';
import { probeClerkBackendReadiness } from './clerk-backend-readiness';
import { connectorRuntimeRecord } from './connector-build-info';
import { createLocalDevelopmentCodexSessionsRuntime } from './codex-sessions/local-development-runtime';
import {
  initializeOpenTelemetry,
  installProcessErrorHandlers,
  projectSpaceLogger,
  shutdownOpenTelemetry
} from './observability';

const version = connectorRuntimeRecord().version;
const command = process.argv[2] ?? 'serve';

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`Project Space ${version}

Usage:
  bun server/web-server.ts [serve]
  bun server/web-server.ts --version

Environment:
  PROJECT_SPACE_HOST  Host to bind. Defaults to 127.0.0.1.
  PROJECT_SPACE_PORT  Port to bind. Defaults to 4173.
  CLERK_SECRET_KEY  Clerk secret key for Project Space login.
  PROJECT_SPACE_ALLOWED_EMAILS  Comma-separated Clerk membership allowlist; required in production.
  PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_EMAIL  Tailnet owner allowed to discover/classify devices.
  PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_SUBJECT_SHA256  SHA-256 of the Clerk subject allowed to discover/classify Tailnet devices.
  TAILSCALE_OAUTH_CLIENT_ID  Deployment-owned Tailscale OAuth client ID.
  TAILSCALE_OAUTH_CLIENT_SECRET  Deployment-owned Tailscale OAuth client secret.
  PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET  Independent secret for public machine enrollment limits.
  PROJECT_SPACE_PUBLIC_ORIGIN  Public HTTPS origin used for machine approval links.
  PROJECT_SPACE_PREVIEW_MODE=1  Accept only trusted Preview gateway identity assertions.
  PROJECT_SPACE_PREVIEW_GATEWAY_SECRET  PR-scoped key used to verify Preview assertions.
  GITHUB_OAUTH_CLIENT_ID  GitHub OAuth app client ID for repository connection.
  PROJECT_SPACE_TOKEN_ENCRYPTION_KEY  Independent key for stored GitHub OAuth tokens.
  PROJECT_SPACE_AUTH_DISABLED=1  Disable login protection for trusted local debugging only.
  PROJECT_SPACE_LOG_LEVEL  Structured log level: debug, info, warn, error, or fatal.
  PROJECT_SPACE_LOCAL_CODEX_MACHINE_ID  Development-only machine id for the local Codex app-server.
  PROJECT_SPACE_LOCAL_CODEX_MACHINE_NAME  Optional display name for that local Codex machine.
  OTEL_EXPORTER_OTLP_ENDPOINT  Optional OTLP collector base URL for traces and metrics.

After starting Project Space, open:
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
  console.error('Run bun server/web-server.ts --help for usage.');
  process.exit(1);
}

const logger = projectSpaceLogger.child({ component: 'server', version });
if (
  process.env.PROJECT_DEPLOY_ENVIRONMENT === 'prod' &&
  !hasDedicatedGitHubOAuthTokenEncryptionKey()
) {
  logger.warn('github.oauth.token.encryption.legacy_fallback', {
    action: 'configure-dedicated-key'
  });
}
await initializeOpenTelemetry(logger);
installProcessErrorHandlers(logger);
const port = Number(process.env.PORT ?? process.env.PROJECT_SPACE_PORT ?? 4173);
const host = process.env.PROJECT_SPACE_HOST ?? '127.0.0.1';
const staticRoot = resolve(process.cwd(), 'dist/renderer');
const backend = createLocalProjectSpaceBackend();
const machineConnectionRuntime = await createConfiguredMachineConnectionRuntime();
const localCodexMachineId = process.env.PROJECT_SPACE_LOCAL_CODEX_MACHINE_ID?.trim();
if (localCodexMachineId && process.env.PROJECT_DEPLOY_ENVIRONMENT === 'prod') {
  throw new Error('PROJECT_SPACE_LOCAL_CODEX_MACHINE_ID is disabled in production.');
}
const localCodex = localCodexMachineId
  ? await createLocalDevelopmentCodexSessionsRuntime({
      machineId: localCodexMachineId,
      machineName: process.env.PROJECT_SPACE_LOCAL_CODEX_MACHINE_NAME?.trim() || 'Local Codex'
    })
  : undefined;
const authReadiness = await probeClerkBackendReadiness();
if (!authReadiness.ready) {
  logger.error('auth.clerk.readiness.failed', { code: authReadiness.code });
}
const server = await createProjectSpaceServer({
  authReadiness,
  backend,
  codexSessions: localCodex?.handleRequest,
  host,
  machineConnectionRuntime: machineConnectionRuntime ?? undefined,
  logger,
  port,
  staticRoot
});
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  let exitCode = 0;
  try {
    await server.close();
    await localCodex?.close();
  } catch (error) {
    exitCode = 1;
    logger.error('server.shutdown.failed', {}, error);
  }
  await shutdownOpenTelemetry(logger);
  process.exit(exitCode);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

logger.info('server.started', { mode: 'fullstack', origin: server.origin });
