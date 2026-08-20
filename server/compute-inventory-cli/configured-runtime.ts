import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import { loadConfiguredComputeInventory } from '../configured-compute-inventory';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from '../local-auth-store';
import { getPrivateNetworkStore } from '../local-database-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { selectAuthorizedAccessRoute } from '../private-network/route-resolver';
import { targetIdentityRevision } from '../private-network/contracts';
import type { PrivateNetworkInventory } from '../private-network/contracts';
import { createComputeInventoryCliHttpApi } from './http';
import { buildProjectCliComputeInventory } from './service';
import type { ProjectHostdService } from '../project-hostd/service';
import type { WorkspaceRuntimeSessionService } from '../workspace-runtime-session/service';

export function createConfiguredComputeInventoryCliHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  projectHostd?: Pick<ProjectHostdService, 'list'>;
  runtimeSessions?: Pick<WorkspaceRuntimeSessionService, 'list'>;
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
    async list(actor, schemaVersion) {
      return runWithAuthSession(machineSession(actor.userId), async () => {
        const loaded = await loadConfiguredComputeInventory({
          backend: options.backend,
          userId: actor.userId
        });
        const privateNetworkStore = await getPrivateNetworkStore();
        const privateNetworkInventory = privateNetworkStore
          ? await privateNetworkStore.list(actor.userId)
          : { networks: [], routes: [] };
        const authorizedInteractiveRouteIds = await authorizeInteractiveRoutes({
          checkedAt: loaded.checkedAt,
          gatewayId: actor.callerMachineId,
          inventory: privateNetworkInventory,
          snapshot: loaded.snapshot,
          userId: actor.userId
        });
        return buildProjectCliComputeInventory({
          authorizedInteractiveRouteIds,
          ...loaded,
          hostdSnapshots: schemaVersion === 3 && options.projectHostd
            ? await options.projectHostd.list(actor.userId)
            : [],
          privateNetworkInventory,
          runtimeSessions: options.runtimeSessions
            ? await options.runtimeSessions.list(actor.userId)
            : [],
          schemaVersion
        });
      });
    }
  }, resolveActor);
}

async function authorizeInteractiveRoutes(input: {
  checkedAt: string;
  gatewayId?: string;
  inventory: PrivateNetworkInventory;
  snapshot: ComputeInventorySnapshot;
  userId: string;
}) {
  const now = new Date(input.checkedAt);
  const routeIds = new Set<string>();
  const gatewayId = input.gatewayId;
  if (!gatewayId) return routeIds;
  for (const environment of input.snapshot.environments) {
    const candidate = input.inventory.routes.find((route) =>
      route.target.kind === 'environment' && route.target.id === environment.id &&
      route.ownerUserId === input.userId && route.allowedGatewayIds.length > 0 &&
      route.allowedGatewayIds.includes(gatewayId) &&
      route.capabilities.includes('interactive_shell')
    );
    if (!candidate) continue;
    const selection = await selectAuthorizedAccessRoute({
      authorization: {
        allowed: true,
        capability: 'interactive_shell',
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        gatewayId,
        ownerUserId: input.userId,
        risk: 'interactive',
        target: {
          id: environment.id,
          identityRevision: targetIdentityRevision(environment.identity),
          kind: 'environment'
        }
      },
      loadCandidates: async () => input.inventory,
      now
    });
    if (selection.state === 'ready') routeIds.add(selection.route.routeId);
  }
  return routeIds;
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
