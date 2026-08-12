import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import { loadConfiguredComputeInventory } from '../configured-compute-inventory';
import { isProjectSpaceAuthRequired, readAuthSessionFromRequest } from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import type { WorkspaceRuntimeSessionService } from '../workspace-runtime-session/service';
import { createProjectHostdHttpApi } from './http';
import type { ProjectHostdStore } from './contracts';
import { ProjectHostdService } from './service';

export function createConfiguredProjectHostdRuntime(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  runtimeSessions: WorkspaceRuntimeSessionService;
  store: ProjectHostdStore;
}) {
  const service = new ProjectHostdService(
    options.store,
    {
      async resolve({ environmentId, hostId, ownerUserId }) {
        const inventory = await loadConfiguredComputeInventory({
          backend: options.backend,
          userId: ownerUserId
        });
        const environment = inventory.snapshot.environments.find(({ id }) => id === environmentId);
        if (!environment) return 'missing';
        const actualHostId = environment.hostAssociation.resolution === 'verified' ||
          environment.hostAssociation.resolution === 'manual'
          ? environment.hostAssociation.hostId
          : undefined;
        if (actualHostId !== hostId || environment.identityResolution === 'conflict' ||
          environment.hostAssociation.resolution === 'conflict') return 'conflict';
        return 'matched';
      }
    },
    {
      async registered({ environmentId, ownerUserId, runtimes }) {
        const sessions = await options.runtimeSessions.list(ownerUserId);
        return runtimes.every((runtime) => sessions.some((session) =>
          session.environmentId === environmentId && session.generation === runtime.generation &&
          session.workspaceId === runtime.workspaceId && session.connectionState !== 'stopped'
        ));
      }
    }
  );
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
  return {
    handleRequest: createProjectHostdHttpApi(service, resolveActor),
    service
  };
}
