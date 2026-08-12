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

export function createConfiguredCanonicalRuntimeControlHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  runtimeSessions?: WorkspaceRuntimeSessionService;
}) {
  let runtime: Promise<ReturnType<typeof createCanonicalRuntimeControlHttpApi>> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== '/api/runtime-control/v1/operations') return false;
    if (!isDatabaseConfigured() || !options.runtimeSessions) return unavailable(response);
    try {
      runtime ??= createHandler({
        machineConnection: options.machineConnection,
        runtimeSessions: options.runtimeSessions
      });
      return await (await runtime)(request, response, url);
    } catch {
      runtime = undefined;
      return unavailable(response);
    }
  };
}

async function createHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  runtimeSessions: WorkspaceRuntimeSessionService;
}) {
  const operations = new PostgresCanonicalRuntimeControlOperationStore(
    await getMachineConnectionDatabaseClient()
  );
  const dispatcher = createWorkspaceRuntimeControlDispatcher(options.runtimeSessions, operations);
  const service = createCanonicalRuntimeControlService({
    authorizer: {
      async authorize(input) {
        if (!input.actor.ownerUserId || !input.actor.actorId) return false;
        return input.phase === 'coarse' || (
          input.target.environmentId.length > 0 && input.target.workspaceId.length > 0
        );
      }
    },
    dispatcher,
    inventory: {
      compute: listComputeInventory,
      runtimes: (ownerUserId) => options.runtimeSessions.list(ownerUserId)
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
