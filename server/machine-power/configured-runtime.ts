import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import {
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured,
  listPhysicalMachines
} from '../local-database-store';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest
} from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { writeJson } from '../project-space-http-response';
import { loadMachinePowerBindings } from './config';
import { createMachinePowerHttpApi } from './http';
import { createJetKvmMqttProvider } from './provider';
import { createMachinePowerService } from './service';
import { PostgresMachinePowerOperationStore } from './store';

export function createConfiguredMachinePowerHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
  let runtime: Promise<ReturnType<typeof createMachinePowerHttpApi>> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== '/api/machine-power') return false;
    if (!isDatabaseConfigured()) {
      writeJson(response, 503, {
        error: {
          code: 'machine_power_unavailable',
          message: 'Machine power control requires the Project Space database.'
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
          code: 'machine_power_unavailable',
          message: 'Machine power control is temporarily unavailable.'
        }
      });
      return true;
    }
  };
}

async function createHandler(options: {
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
  const database = await getMachineConnectionDatabaseClient();
  const configRoot = process.env.PROJECT_SPACE_MACHINE_POWER_CONFIG_ROOT ??
    resolve(process.cwd(), 'config/machine-power');
  const service = createMachinePowerService({
    bindings: () => loadMachinePowerBindings(configRoot),
    inventory: listPhysicalMachines,
    operations: new PostgresMachinePowerOperationStore(database),
    provider: createJetKvmMqttProvider()
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
  return createMachinePowerHttpApi(service, resolveActor);
}
