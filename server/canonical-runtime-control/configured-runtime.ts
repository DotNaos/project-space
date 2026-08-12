import type { IncomingMessage, ServerResponse } from 'node:http';

import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import { getMachineConnectionDatabaseClient, isDatabaseConfigured, listComputeInventory } from '../local-database-store';
import { isProjectSpaceAuthRequired, readAuthSessionFromRequest } from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { writeJson } from '../project-space-http-response';
import type { WorkspaceRuntimeSessionService } from '../workspace-runtime-session/service';
import { createCanonicalRuntimeControlService } from './service';
import { createCanonicalRuntimeControlHttpApi } from './http';
import { PostgresCanonicalRuntimeControlOperationStore } from './postgres-operation-store';
import { createWorkspaceRuntimeControlDispatcher } from './workspace-runtime-dispatcher';
import type { CanonicalRuntimeControlOperationStore } from './operation-store-contracts';

export function createCanonicalRuntimeControlRuntime(options: {
  inventory?: {
    compute(ownerUserId: string): ReturnType<typeof listComputeInventory>;
    runtimes(ownerUserId: string): ReturnType<WorkspaceRuntimeSessionService['list']>;
  };
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  operations: CanonicalRuntimeControlOperationStore;
  runtimeSessions: WorkspaceRuntimeSessionService;
}) {
  const dispatcher = createWorkspaceRuntimeControlDispatcher(
    options.runtimeSessions,
    options.operations
  );
  return {
    close: () => dispatcher.close(),
    handleRequest: createHandler({ ...options, dispatcher })
  };
}

export function createConfiguredCanonicalRuntimeControlHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  runtimeSessions?: WorkspaceRuntimeSessionService;
}) {
  let runtime: Promise<ReturnType<typeof createCanonicalRuntimeControlHttpApi>> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== '/api/runtime-control/v1/operations') return false;
    if (!isDatabaseConfigured() || !options.runtimeSessions) return unavailable(response);
    try {
      runtime ??= getMachineConnectionDatabaseClient().then((database) => (
        createCanonicalRuntimeControlRuntime({
          machineConnection: options.machineConnection,
          operations: new PostgresCanonicalRuntimeControlOperationStore(database),
          runtimeSessions: options.runtimeSessions!
        }).handleRequest
      ));
      return await (await runtime)(request, response, url);
    } catch {
      runtime = undefined;
      return unavailable(response);
    }
  };
}

function createHandler(options: {
  dispatcher?: ReturnType<typeof createWorkspaceRuntimeControlDispatcher>;
  inventory?: {
    compute(ownerUserId: string): ReturnType<typeof listComputeInventory>;
    runtimes(ownerUserId: string): ReturnType<WorkspaceRuntimeSessionService['list']>;
  };
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  operations?: CanonicalRuntimeControlOperationStore;
  runtimeSessions: WorkspaceRuntimeSessionService;
}) {
  if (!options.dispatcher) throw new Error('Canonical Runtime dispatcher is unavailable.');
  const service = createCanonicalRuntimeControlService({
    authorizer: {
      async authorize(input) {
        if (!input.actor.ownerUserId || !input.actor.actorId) return false;
        return input.phase === 'coarse' || (
          input.target.environmentId.length > 0 && input.target.workspaceId.length > 0
        );
      }
    },
    dispatcher: options.dispatcher,
    inventory: {
      compute: options.inventory?.compute ?? listComputeInventory,
      runtimes: options.inventory?.runtimes ?? ((ownerUserId) => options.runtimeSessions.list(ownerUserId))
    }
  });
  const authenticate = createCodexMachineTasksAuthResolver({
    authenticateMachine: async ({ machineId, token }) => (
      options.machineConnection?.resolveMachineCredentialIdentity(token, machineId) ?? null
    ),
    authRequired: isProjectSpaceAuthRequired,
    readHuman: async (request) => {
      const session = await readAuthSessionFromRequest(request);
      return session ? { userId: session.userId } : null;
    }
  });
  return createCanonicalRuntimeControlHttpApi(service, async (request) => {
    const authenticated = await authenticate(request);
    return {
      actorId: authenticated.callerMachineId ?? authenticated.userId,
      actorKind: authenticated.callerMachineId ? 'agent' : 'human',
      ownerUserId: authenticated.userId
    };
  });
}

function unavailable(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store');
  writeJson(response, 503, {
    error: { code: 'target_unavailable', message: 'Canonical Runtime control is unavailable.' }
  });
  return true;
}
