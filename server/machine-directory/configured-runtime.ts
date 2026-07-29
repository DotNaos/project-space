import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import {
  createConfiguredCodexSessionsRuntime
} from '../codex-sessions/configured-runtime';
import type { CodexSessionsRuntime } from '../codex-sessions/runtime';
import {
  isDatabaseConfigured,
  listAuthorizedMachineIdentities,
  listPhysicalMachines
} from '../local-database-store';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { writeJson } from '../project-space-http-response';
import { createMachineDirectoryHttpApi } from './http';
import { createMachineHostProber } from './probe';
import {
  createMachineDirectoryService,
  type MachineDirectoryIdentity
} from './service';

const routePrefixes = ['/api/machines/catalog', '/api/codex/catalog'];

export interface ConfiguredMachineDirectoryOptions {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  databaseConfigured?(): boolean;
  identities?(userId: string): Promise<MachineDirectoryIdentity[]>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  physicalMachines?(userId: string): ReturnType<typeof listPhysicalMachines>;
  probe?: ReturnType<typeof createMachineHostProber>;
  sessionsRuntime?: Promise<CodexSessionsRuntime> | CodexSessionsRuntime;
}

export function createConfiguredMachineDirectoryHandler(
  options: ConfiguredMachineDirectoryOptions
) {
  const configured = options.databaseConfigured ?? isDatabaseConfigured;
  const service = createService(options);
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
  const handler = createMachineDirectoryHttpApi(service, resolveActor);

  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!routePrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      return false;
    }
    if (!configured()) {
      writeJson(response, 503, {
        error: {
          code: 'directory_unavailable',
          message: 'Machine discovery requires the Project Space database.'
        }
      });
      return true;
    }
    return handler(request, response, url);
  };
}

function createService(options: ConfiguredMachineDirectoryOptions) {
  let sessions = options.sessionsRuntime
    ? Promise.resolve(options.sessionsRuntime)
    : undefined;
  const loadSessions = () => (
    sessions ??= createConfiguredCodexSessionsRuntime()
  );
  const loadPhysical = options.physicalMachines ?? listPhysicalMachines;
  const loadIdentities = options.identities ?? listAuthorizedMachineIdentities;

  return createMachineDirectoryService({
    async inventory(userId) {
      return runWithAuthSession(machineSession(userId), async () => {
        const [overview, physicalMachines, identities] = await Promise.all([
          options.backend.getConnectorOverview(),
          loadPhysical(userId),
          loadIdentities(userId)
        ]);
        const allowedConnectorIds = new Set(
          physicalMachines.flatMap((machine) => machine.connectorIds)
        );
        return {
          connectors: overview.machines.filter((machine) =>
            allowedConnectorIds.has(machine.id)
          ),
          identities,
          physicalMachines
        };
      });
    },
    async listCodexSessions(userId, connectorId, request) {
      const runtime = await loadSessions();
      return runtime.service.list(
        { userId },
        {
          includeArchived: request.includeArchived,
          machineId: connectorId,
          ...(request.search ? { search: request.search } : {})
        }
      );
    },
    probe: options.probe ?? createMachineHostProber()
  });
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
