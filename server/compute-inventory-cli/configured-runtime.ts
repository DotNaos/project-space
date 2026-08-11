import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import { loadConfiguredComputeInventory } from '../configured-compute-inventory';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { createComputeInventoryCliHttpApi } from './http';
import { buildProjectCliComputeInventory } from './service';

export function createConfiguredComputeInventoryCliHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
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
  return createComputeInventoryCliHttpApi({
    async list(actor) {
      return runWithAuthSession(machineSession(actor.userId), async () => {
        const loaded = await loadConfiguredComputeInventory({
          backend: options.backend,
          userId: actor.userId
        });
        return buildProjectCliComputeInventory(loaded);
      });
    }
  }, resolveActor);
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
