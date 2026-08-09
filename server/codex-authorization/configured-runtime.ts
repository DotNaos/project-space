import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { requestConnectorCodexSessions } from '../connector-command-hub';
import { connectorSessionGeneration } from '../connector-command-session-registry';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import {
  isDatabaseConfigured,
  listComputeInventory,
  listPhysicalMachines
} from '../local-database-store';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { writeJson } from '../project-space-http-response';
import { createCodexAuthorizationHttpApi } from './http';
import { createCodexAuthorizationService } from './service';

export function createConfiguredCodexAuthorizationHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
  let runtime: Promise<ReturnType<typeof createCodexAuthorizationHttpApi>> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== '/api/codex/authorization') return false;
    if (!isDatabaseConfigured()) {
      writeJson(response, 503, {
        error: {
          code: 'codex_authorization_unavailable',
          message: 'Codex authorization requires the Project Space database.'
        }
      });
      return true;
    }
    try {
      runtime ??= createHandler(options);
      return await (await runtime)(request, response, url);
    } catch {
      runtime = undefined;
      writeJson(response, 503, {
        error: {
          code: 'codex_authorization_unavailable',
          message: 'Codex authorization is temporarily unavailable.'
        }
      });
      return true;
    }
  };
}

async function createHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
  const service = createCodexAuthorizationService({
    async dispatch(input) {
      const response = await requestConnectorCodexSessions(
        'authorization',
        {
          action: input.action,
          machineId: input.connectorId,
          operationId: input.operationId
        },
        {
          generation: input.generation,
          operationId: input.operationId,
          timeoutMs: 20_000,
          userId: input.userId
        }
      );
      if (response.operation !== 'authorization') {
        throw new Error('The connector returned an invalid authorization response.');
      }
      return response.result;
    },
    generationFor: connectorSessionGeneration,
    async inventory(userId) {
      return runWithAuthSession(machineSession(userId), async () => ({
        computeInventory: await listComputeInventory(userId),
        connectors: (await options.backend.getConnectorOverview()).machines,
        physicalMachines: await listPhysicalMachines(userId)
      }));
    }
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
  return createCodexAuthorizationHttpApi(service, resolveActor);
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
