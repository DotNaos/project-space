import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { connectorSessionGeneration } from '../connector-command-session-registry';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import {
  isDatabaseConfigured,
  listPhysicalMachines
} from '../local-database-store';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { writeJson } from '../project-space-http-response';
import { createMachineReadinessHttpApi } from './http';
import { createMachineReadinessService } from './service';
import { requestConnectorCodexSessions } from '../codex-sessions/connector-hub';

export interface ConfiguredMachineReadinessOptions {
  backend: Pick<
    ProjectSpaceBackend,
    'getConnectorOverview' | 'getMachineRuntime' | 'startMachineRuntimeOperation'
  >;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}

export function createConfiguredMachineReadinessHandler(
  options: ConfiguredMachineReadinessOptions
) {
  let runtime: Promise<ReturnType<typeof createMachineReadinessHttpApi>> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== '/api/machine-readiness') return false;
    if (!isDatabaseConfigured()) {
      writeJson(response, 503, {
        error: {
          code: 'machine_readiness_unavailable',
          message: 'Machine readiness requires the Project Space database.'
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
          code: 'machine_readiness_unavailable',
          message: 'Machine readiness is temporarily unavailable.'
        }
      });
      return true;
    }
  };
}

async function createHandler(options: ConfiguredMachineReadinessOptions) {
  const service = createMachineReadinessService({
    generationFor: connectorSessionGeneration,
    async inventory(userId) {
      return runWithAuthSession(machineSession(userId), async () => ({
        connectors: (await options.backend.getConnectorOverview()).machines,
        physicalMachines: await listPhysicalMachines(userId)
      }));
    },
    runtimeStatus(connectorId, userId) {
      return runWithAuthSession(
        machineSession(userId),
        () => options.backend.getMachineRuntime(connectorId)
      );
    },
    async startDaemonOperation(connectorId, operation, operationId, userId) {
      return runWithAuthSession(machineSession(userId), async () => {
        const response = await requestConnectorCodexSessions('daemon', {
          machineId: connectorId,
          operation,
          operationId
        }, {
          operationId,
          userId
        });
        if (response.operation !== 'daemon') {
          throw new Error('The connector returned an invalid managed daemon result.');
        }
        return response.result;
      });
    },
    startRuntimeOperation(connectorId, request, userId) {
      return runWithAuthSession(
        machineSession(userId),
        () => options.backend.startMachineRuntimeOperation(connectorId, request)
      );
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
  return createMachineReadinessHttpApi(service, resolveActor);
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
