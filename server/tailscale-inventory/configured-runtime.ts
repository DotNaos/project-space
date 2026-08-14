import { createHash, timingSafeEqual } from 'node:crypto';

import {
  CodexMachineTasksAuthError,
  createCodexMachineTasksAuthResolver
} from '../codex-machine-tasks/auth-context';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest
} from '../local-auth-store';
import { getTailscaleInventoryStore } from '../local-database-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { createCommandTailscaleInventorySource } from './command-source';
import { createTailscaleInventoryHttpApi } from './http';
import { createProxyTailscaleInventorySource } from './proxy-source';
import { createTailscaleInventoryService } from './service';
import type { TailscaleInventorySource } from './source';

export function createConfiguredTailscaleInventoryHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  source?: TailscaleInventorySource;
}) {
  const source = options.source ?? configuredSource(process.env);
  let service: ReturnType<typeof createTailscaleInventoryService> | undefined;
  const getService = async () => {
    if (service) return service;
    const store = await getTailscaleInventoryStore();
    if (!store) {
      throw new Error('Tailscale inventory persistence is unavailable.');
    }
    service = createTailscaleInventoryService({ source, store });
    return service;
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
      return (await getService()).list(ownerUserId, refresh);
    },
    async setClassification(actor, deviceId, request) {
      return (await getService()).setClassification(actor, deviceId, request);
    }
  }, async (request) => {
    const actor = await resolve(request);
    if ('callerMachineId' in actor && actor.callerMachineId) {
      return { actorId: actor.callerMachineId, kind: 'machine', ownerUserId: actor.userId };
    }
    if (isProjectSpaceAuthRequired()) {
      const session = await readAuthSessionFromRequest(request);
      if (!session || !isConfiguredInventoryOwner(session, process.env)) {
        throw new CodexMachineTasksAuthError(403);
      }
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

function configuredSource(environment: NodeJS.ProcessEnv): TailscaleInventorySource {
  const mode = environment.PROJECT_SPACE_TAILSCALE_INVENTORY_SOURCE?.trim() || 'command';
  if (mode === 'command') return createCommandTailscaleInventorySource();
  if (mode === 'proxy') return createProxyTailscaleInventorySource();
  throw new Error('PROJECT_SPACE_TAILSCALE_INVENTORY_SOURCE must be command or proxy.');
}
