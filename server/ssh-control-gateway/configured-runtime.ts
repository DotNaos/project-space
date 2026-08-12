import type { IncomingMessage, ServerResponse } from 'node:http';

import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import {
  getMachineConnectionDatabaseClient,
  getPrivateNetworkStore,
  isDatabaseConfigured,
  listComputeInventory
} from '../local-database-store';
import { isProjectSpaceAuthRequired, readAuthSessionFromRequest } from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { writeJson } from '../project-space-http-response';
import type { SshGatewayAuthorizationProvider } from './contracts';
import { SshGatewayError } from './contracts';
import { createSshControlGatewayHttpApi } from './http';
import { OnePasswordSshCredentialResolver } from './one-password-resolver';
import { OpenSshControlTransport } from './openssh-transport';
import { PostgresSshGatewayOperationStore } from './postgres-store';
import { SshControlGatewayService } from './service';
import { InventorySshGatewayTargetResolver } from './target-resolver';

const routes = new Set([
  '/api/compute/control/status',
  '/api/compute/control/workspace-runtime'
]);

export function isConfiguredSshControlGatewayRoute(pathname: string) {
  return routes.has(pathname);
}

export function createConfiguredSshControlGatewayHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
  let runtime: Promise<ReturnType<typeof createSshControlGatewayHttpApi>> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!isConfiguredSshControlGatewayRoute(url.pathname)) return false;
    if (!isDatabaseConfigured() || !configuredGatewayId()) {
      unavailable(response);
      return true;
    }
    try {
      runtime ??= createHandler(options);
      return await (await runtime)(request, response, url);
    } catch {
      runtime = undefined;
      unavailable(response);
      return true;
    }
  };
}

async function createHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
  const database = await getMachineConnectionDatabaseClient();
  const routeStore = await getPrivateNetworkStore();
  const gatewayId = configuredGatewayId();
  if (!routeStore || !gatewayId) throw new Error('SSH control is not configured.');
  const targets = new InventorySshGatewayTargetResolver({ load: listComputeInventory });
  const authorization: SshGatewayAuthorizationProvider = {
    async authorize({ actor, environmentId }) {
      if (actor.kind !== 'machine') {
        throw new SshGatewayError('authorization_denied', 'Machine authentication is required.');
      }
      const target = await targets.resolve(actor.ownerUserId, environmentId);
      return {
        allowed: true,
        capability: 'project_cli',
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        gatewayId,
        ownerUserId: actor.ownerUserId,
        reason: 'owner_machine_status',
        risk: 'normal',
        target: {
          id: target.environmentId,
          identityRevision: target.targetIdentityRevision,
          kind: 'environment'
        }
      };
    }
  };
  const service = new SshControlGatewayService({
    authorization,
    credentials: new OnePasswordSshCredentialResolver(),
    operations: new PostgresSshGatewayOperationStore(database),
    routes: { load: (ownerUserId) => routeStore.list(ownerUserId) },
    targets,
    transport: new OpenSshControlTransport()
  });
  const resolveActor = createCodexMachineTasksAuthResolver({
    authenticateMachine: async ({ machineId, token }) => (
      options.machineConnection?.resolveMachineCredentialIdentity(token, machineId) ?? null
    ),
    authRequired: isProjectSpaceAuthRequired,
    readHuman: async (request) => {
      const session = await readAuthSessionFromRequest(request);
      return session ? { userId: session.userId } : null;
    }
  });
  return createSshControlGatewayHttpApi(service, resolveActor);
}

function configuredGatewayId() {
  const value = process.env.PROJECT_SPACE_SSH_CONTROL_GATEWAY_ID?.trim();
  return value && /^[A-Za-z0-9:._-]{1,256}$/.test(value) ? value : undefined;
}

function unavailable(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store');
  writeJson(response, 503, {
    error: { code: 'ssh_control_unavailable', message: 'SSH control is not configured.' }
  });
}
