import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { createProjectCatalogCliHttpApi } from './project-catalog-cli-http';
import { buildProjectCliCatalog } from './project-catalog-service';

export interface ConfiguredProjectCatalogCliOptions {
  backend: Pick<ProjectSpaceBackend, 'getGitHubCatalog' | 'loadProjectDiscovery'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}

export function createConfiguredProjectCatalogCliHandler(
  options: ConfiguredProjectCatalogCliOptions
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
  return createProjectCatalogCliHttpApi({
    async list(actor) {
      const [catalog, discovery] = await runWithAuthSession(
        machineSession(actor.userId),
        () => Promise.all([
          options.backend.getGitHubCatalog({ forceRefresh: false }),
          options.backend.loadProjectDiscovery()
        ])
      );
      return buildProjectCliCatalog(catalog, discovery, actor.callerMachineId ?? '');
    }
  }, resolveActor);
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
