import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  CodexAuthorizationRequest,
  CodexAuthorizationResult
} from '../../src/shared/codex-authorization-api';
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

export interface CodexAuthorizationRuntime {
  authorize(
    actor: { userId: string },
    request: CodexAuthorizationRequest
  ): Promise<CodexAuthorizationResult>;
}

export interface ConfiguredCodexAuthorizationOptions {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}

export function createConfiguredCodexAuthorizationRuntime(
  options: ConfiguredCodexAuthorizationOptions
): CodexAuthorizationRuntime {
  return createCodexAuthorizationService({
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
}

export function createConfiguredCodexAuthorizationHandler(
  options: ConfiguredCodexAuthorizationOptions & {
    runtime?: CodexAuthorizationRuntime;
  }
) {
  let httpApi: ReturnType<typeof createCodexAuthorizationHttpApi> | undefined;
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
      httpApi ??= createHttpApi(
        options.runtime ?? createConfiguredCodexAuthorizationRuntime(options),
        options
      );
      return await httpApi(request, response, url);
    } catch {
      httpApi = undefined;
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

function createHttpApi(
  runtime: CodexAuthorizationRuntime,
  options: ConfiguredCodexAuthorizationOptions
) {
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
  return createCodexAuthorizationHttpApi(runtime, resolveActor);
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
