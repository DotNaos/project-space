/**
 * Local Project Chat identity harness.
 *
 * Required environment:
 * - DATABASE_URL: loopback PostgreSQL database used for real migrations and identity state.
 * - PROJECT_CHAT_E2E_CREDENTIAL_FILE: nonexistent output path in an existing temp directory.
 *
 * Optional environment:
 * - PORT: fixed server port (defaults to 4173).
 *
 * The output file is created exclusively with mode 0600 after its credential resolves through
 * the PostgreSQL-backed MachineConnectionRuntime. The credential value is never logged.
 */
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';
import { getMachineConnectionDatabaseClient } from '../server/local-database-store';
import { DatabaseMachineConnectionStore } from '../server/machine-connection-database-store';
import { createMachineConnectionRuntime } from '../server/machine-connection-runtime';
import { createProjectSpaceServer } from '../server/project-space-http';
import {
  enrollProjectChatE2EMachine,
  writePrivateProjectChatE2ECredential
} from './project-chat-e2e-machine';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required.');
}
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname)) {
  throw new Error('DATABASE_URL must point to a loopback PostgreSQL instance.');
}
const credentialFile = process.env.PROJECT_CHAT_E2E_CREDENTIAL_FILE?.trim();
if (!credentialFile) {
  throw new Error('PROJECT_CHAT_E2E_CREDENTIAL_FILE is required.');
}
if (process.env.PROJECT_CHAT_E2E_MACHINE_TOKEN) {
  throw new Error(
    'PROJECT_CHAT_E2E_MACHINE_TOKEN is not accepted by the server; use the private credential file.'
  );
}

const port = Number(process.env.PORT ?? 4173);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer from 1 through 65535.');
}

const hostId = 'e2e-os-macbook';
const userId = 'local-development-user';
const publicOrigin = `http://127.0.0.1:${port}`;
const databaseClient = await getMachineConnectionDatabaseClient();
const machineConnectionRuntime = createMachineConnectionRuntime({
  databaseClient,
  isMachineOnline: () => false,
  publicOrigin,
  rateLimitSecret: randomBytes(32),
  async readAuthenticatedUserId() {
    return userId;
  }
});

const server = await createProjectSpaceServer({
  backend: createLocalProjectSpaceBackend(),
  host: '127.0.0.1',
  machineConnectionRuntime,
  port,
  staticRoot: resolve(process.cwd(), 'dist/renderer')
});

try {
  const credential = await enrollProjectChatE2EMachine({
    backendUrl: server.origin,
    hostId,
    store: new DatabaseMachineConnectionStore(databaseClient),
    userId
  });
  const identity = await machineConnectionRuntime.resolveMachineCredentialIdentity(
    credential.credential,
    credential.machineId
  );
  if (
    identity?.hostId !== hostId ||
    identity.machineId !== credential.machineId ||
    identity.userId !== userId
  ) {
    throw new Error('Enrolled E2E credential did not resolve to its trusted identity.');
  }
  await writePrivateProjectChatE2ECredential(credentialFile, credential);
} catch (error) {
  await server.close();
  throw error;
}

let stopping = false;
function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  void server.close()
    .finally(() => rm(credentialFile, { force: true }))
    .finally(() => process.exit(0));
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
console.log(`Project Chat E2E server running at ${server.origin}`);
console.log(`Private machine credential is ready at ${credentialFile}`);
