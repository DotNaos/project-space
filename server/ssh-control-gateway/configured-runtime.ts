import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import {
  getMachineConnectionDatabaseClient,
  getPrivateNetworkStore,
  isDatabaseConfigured,
  listComputeInventory
} from '../local-database-store';
import { isProjectSpaceAuthRequired, readAuthSessionFromRequest } from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { writeJson } from '../project-space-http-response';
import { requestPublicOrigin } from '../public-origin';
import type { RuntimeSessionStore } from '../workspace-runtime-session/contracts';
import { PostgresTaskExecutionStore } from '../task-execution/execution-store';
import { createWorkspaceRuntimeMutationLaunchAuthorizer } from '../workspace-runtime-session/mutation-launch-authorizer';
import { createWorkspaceRuntimePresentationResolver } from '../workspace-runtime-session/presentation-resolver';
import {
  createWorkspaceRuntimeLaunchHttpApi,
  workspaceRuntimeCapabilitiesRoute,
  workspaceRuntimeLaunchRoute
} from '../workspace-runtime-session/launch-http';
import {
  createWorkspaceRuntimeClientLaunchHttpApi,
  workspaceRuntimeClientLaunchRoute
} from '../workspace-runtime-session/client-launch-http';
import type { SshGatewayAuthorizationProvider } from './contracts';
import { SshGatewayError } from './contracts';
import { createSshControlGatewayHttpApi } from './http';
import { EnvironmentSshCredentialResolver } from './environment-credential-resolver';
import { OpenSshControlTransport } from './openssh-transport';
import { PostgresSshGatewayOperationStore } from './postgres-store';
import { SshControlGatewayService } from './service';
import { InventorySshGatewayTargetResolver } from './target-resolver';
import { createSshWorktreeAuthorizer } from './worktree-authorizer';

const routes = new Set([
  '/api/compute/control/status',
  '/api/compute/control/workspace-runtime',
  '/api/compute/control/worktree/prepare',
  workspaceRuntimeCapabilitiesRoute,
  workspaceRuntimeLaunchRoute,
  workspaceRuntimeClientLaunchRoute
]);

export function isConfiguredSshControlGatewayRoute(pathname: string) {
  return routes.has(pathname);
}

export function createConfiguredSshControlGatewayHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getGitHubCatalog'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  runtimeSessions?: Pick<RuntimeSessionStore, 'issue' | 'revoke'>;
}) {
  let runtime: Promise<ReturnType<typeof createSshControlGatewayHttpApi>> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!isConfiguredSshControlGatewayRoute(url.pathname)) return false;
    if (
      (url.pathname === workspaceRuntimeLaunchRoute ||
        url.pathname === workspaceRuntimeClientLaunchRoute) &&
      !options.runtimeSessions
    ) {
      unavailable(response);
      return true;
    }
    if (!isDatabaseConfigured() || !configuredGatewayId()) {
      unavailable(response);
      return true;
    }
    try {
      runtime ??= createHandler(options);
      return await (await runtime)(request, response, url);
    } catch {
      runtime = undefined;
      unavailable(response);
      return true;
    }
  };
}

async function createHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getGitHubCatalog'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  runtimeSessions?: Pick<RuntimeSessionStore, 'issue' | 'revoke'>;
}) {
  const database = await getMachineConnectionDatabaseClient();
  const taskExecutions = new PostgresTaskExecutionStore(database);
  const routeStore = await getPrivateNetworkStore();
  const gatewayId = configuredGatewayId();
  if (!routeStore || !gatewayId) throw new Error('SSH control is not configured.');
  const targets = new InventorySshGatewayTargetResolver({ load: listComputeInventory });
  const authorization: SshGatewayAuthorizationProvider = {
    async authorize({ actor, environmentId }) {
      if (actor.kind !== 'machine') {
        throw new SshGatewayError('authorization_denied', 'Machine authentication is required.');
      }
      const target = await targets.resolve(actor.ownerUserId, environmentId);
      return {
        allowed: true,
        capability: 'project_cli',
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        gatewayId,
        ownerUserId: actor.ownerUserId,
        reason: 'owner_machine_status',
        risk: 'normal',
        target: {
          id: target.environmentId,
          identityRevision: target.targetIdentityRevision,
          kind: 'environment'
        }
      };
    }
  };
  const service = new SshControlGatewayService({
    authorization,
    credentials: new EnvironmentSshCredentialResolver(),
    operations: new PostgresSshGatewayOperationStore(database),
    routes: { load: (ownerUserId) => routeStore.list(ownerUserId) },
    targets,
    transport: new OpenSshControlTransport(),
    worktrees: createSshWorktreeAuthorizer(taskExecutions)
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
  const control = createSshControlGatewayHttpApi(service, resolveActor);
  const launch = options.runtimeSessions && createWorkspaceRuntimeLaunchHttpApi({
    authorizeMutation: createWorkspaceRuntimeMutationLaunchAuthorizer(taskExecutions),
    endpoint(request) {
      const endpoint = new URL('/api/workspace-runtimes/socket', requestPublicOrigin(request));
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      return endpoint.toString();
    },
    gateway: service,
    resolveActor,
    resolvePresentation: createWorkspaceRuntimePresentationResolver(options.backend, taskExecutions),
    sessions: options.runtimeSessions
  });
  const clientLaunch = options.runtimeSessions && createWorkspaceRuntimeClientLaunchHttpApi({
    authorizeMutation: createWorkspaceRuntimeMutationLaunchAuthorizer(taskExecutions),
    endpoint(request) {
      const endpoint = new URL('/api/workspace-runtimes/socket', requestPublicOrigin(request));
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      return endpoint.toString();
    },
    resolveActor,
    resolvePresentation: createWorkspaceRuntimePresentationResolver(options.backend, taskExecutions),
    async resolveTarget(ownerUserId, environmentId) {
      const target = await targets.resolve(ownerUserId, environmentId);
      if (!target.hostId) {
        throw new SshGatewayError(
          'route_unavailable',
          'The Environment has no exact Host binding.'
        );
      }
      return target;
    },
    sessions: options.runtimeSessions
  });
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (clientLaunch && await clientLaunch(request, response, url)) return true;
    if (launch && await launch(request, response, url)) return true;
    return control(request, response, url);
  };
}

function configuredGatewayId() {
  const value = process.env.PROJECT_SPACE_SSH_CONTROL_GATEWAY_ID?.trim();
  return value && /^[A-Za-z0-9:._-]{1,256}$/.test(value) ? value : undefined;
}

function unavailable(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store');
  writeJson(response, 503, {
    error: { code: 'ssh_control_unavailable', message: 'SSH control is not configured.' }
  });
}
