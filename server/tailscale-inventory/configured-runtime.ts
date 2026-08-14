import { createHash, timingSafeEqual } from 'node:crypto';

import {
  CodexMachineTasksAuthError,
  createCodexMachineTasksAuthResolver
} from '../codex-machine-tasks/auth-context';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest
} from '../local-auth-store';
import {
  getTailscaleInventoryStore,
  getTailscaleProviderConnectionStore
} from '../local-database-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { createCommandTailscaleInventorySource } from './command-source';
import { createAccountTailscaleInventorySource } from './account-source';
import { createTailscaleInventoryHttpApi } from './http';
import { createTailscaleOAuthApiClient } from './oauth-api-client';
import { createProxyTailscaleInventorySource } from './proxy-source';
import { createTailscaleProviderConnectionService } from './provider-connection-service';
import { createTailscaleInventoryService } from './service';
import type { TailscaleInventorySource } from './source';

export function createConfiguredTailscaleInventoryHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  source?: TailscaleInventorySource;
}) {
  const legacyOwners = new Set<string>();
  let runtime: {
    connection?: ReturnType<typeof createTailscaleProviderConnectionService>;
    inventory: ReturnType<typeof createTailscaleInventoryService>;
  } | undefined;
  const getRuntime = async () => {
    if (runtime) return runtime;
    const store = await getTailscaleInventoryStore();
    if (!store) {
      throw new Error('Tailscale inventory persistence is unavailable.');
    }
    const connections = await getTailscaleProviderConnectionStore();
    const api = createTailscaleOAuthApiClient();
    const source = options.source ?? (connections
      ? createAccountTailscaleInventorySource({
          api,
          connections,
          isLegacyOwner: (ownerUserId) =>
            !isProjectSpaceAuthRequired() || legacyOwners.has(ownerUserId),
          legacy: configuredLegacySource(process.env)
        })
      : configuredLegacySource(process.env));
    const inventory = createTailscaleInventoryService({ source, store });
    runtime = {
      inventory,
      ...(connections ? {
        connection: createTailscaleProviderConnectionService({
          api,
          connections,
          describe: async (ownerUserId) => source.describe?.(ownerUserId) ?? ({
            connectionState: 'not_connected', source: 'not_connected'
          }),
          inventory: store
        })
      } : {})
    };
    return runtime;
  };
  const resolve = createCodexMachineTasksAuthResolver({
    authenticateMachine: async ({ machineId, token }) => (
      options.machineConnection?.resolveMachineCredentialIdentity(token, machineId) ?? null
    ),
    authRequired: isProjectSpaceAuthRequired,
    readHuman: async (request) => {
      const session = await readAuthSessionFromRequest(request);
      return session ? { userId: session.userId } : null;
    }
  });
  return createTailscaleInventoryHttpApi({
    async list(ownerUserId, refresh) {
      return (await getRuntime()).inventory.list(ownerUserId, refresh);
    },
    async setClassification(actor, deviceId, request) {
      return (await getRuntime()).inventory.setClassification(actor, deviceId, request);
    },
    async getConnection(ownerUserId) {
      const connection = (await getRuntime()).connection;
      if (!connection) throw new Error('Tailscale provider connections are unavailable.');
      return connection.get(ownerUserId);
    },
    async connect(actor, request) {
      const connection = (await getRuntime()).connection;
      if (!connection) throw new Error('Tailscale provider connections are unavailable.');
      return connection.connect(actor, request);
    },
    async revoke(actor) {
      const connection = (await getRuntime()).connection;
      if (!connection) throw new Error('Tailscale provider connections are unavailable.');
      return connection.revoke(actor);
    }
  }, async (request) => {
    const actor = await resolve(request);
    if ('callerMachineId' in actor && actor.callerMachineId) {
      return { actorId: actor.callerMachineId, kind: 'machine', ownerUserId: actor.userId };
    }
    if (isProjectSpaceAuthRequired()) {
      const session = await readAuthSessionFromRequest(request);
      if (!session) throw new CodexMachineTasksAuthError(401);
      if (isConfiguredInventoryOwner(session, process.env)) legacyOwners.add(session.userId);
    }
    return { actorId: actor.userId, kind: 'human', ownerUserId: actor.userId };
  });
}

export function isConfiguredInventoryOwner(
  identity: { email?: string; userId: string },
  environment: NodeJS.ProcessEnv
) {
  const configuredSubjectHash = environment
    .PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_SUBJECT_SHA256?.trim()
    .toLowerCase();
  const production = environment.PROJECT_DEPLOY_ENVIRONMENT?.trim() === 'prod';
  if (configuredSubjectHash || production) {
    if (!configuredSubjectHash || !/^[a-f0-9]{64}$/.test(configuredSubjectHash)) {
      return false;
    }
    const actual = createHash('sha256').update(identity.userId).digest();
    const expected = Buffer.from(configuredSubjectHash, 'hex');
    return timingSafeEqual(actual, expected);
  }

  const email = identity.email;
  if (!email) return false;
  const configured = environment.PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_EMAIL?.trim()
    .toLowerCase();
  if (configured) return configured === email.toLowerCase();
  const allowed = (environment.PROJECT_SPACE_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowed.length === 1 && allowed[0] === email.toLowerCase();
}

function configuredLegacySource(environment: NodeJS.ProcessEnv): TailscaleInventorySource {
  const mode = environment.PROJECT_SPACE_TAILSCALE_INVENTORY_SOURCE?.trim() || 'command';
  if (mode === 'command') return createCommandTailscaleInventorySource();
  if (mode === 'proxy') return createProxyTailscaleInventorySource();
  throw new Error('PROJECT_SPACE_TAILSCALE_INVENTORY_SOURCE must be command or proxy.');
}
