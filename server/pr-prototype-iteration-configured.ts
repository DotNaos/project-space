import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import type { PullRequestPrototypeIterationRequest } from '../src/shared/pr-prototype-iteration-api';
import {
  requestConnectorDevServerInspect,
  requestConnectorDevServerList,
  requestConnectorDevServerStart,
  requestConnectorDevServerStop
} from './connector-command-hub';
import { getRegisteredConnectorMachines } from './connector-hub';
import { createConfiguredCodexSessionsRuntime } from './codex-sessions/configured-runtime';
import { createDevServerService } from './dev-server-service';
import {
  createDevServerSession,
  isDatabaseConfigured,
  isMachineClaimed,
  listDevServerSessions,
  listPhysicalMachines,
  readMachineMembership,
  readProjectRunSettings,
  transitionDevServerSession,
  upsertProjectRunSettings
} from './local-database-store';
import { createPullRequestPrototypeIterationService } from './pr-prototype-iteration-service';
import {
  heartbeatConfiguredPullRequestDevServer,
  registerConfiguredPullRequestDevServer
} from './pr-test-surfaces/configured-runtime';

const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
let codexRuntime: ReturnType<typeof createConfiguredCodexSessionsRuntime> | undefined;

export function createConfiguredPullRequestPrototypeIterationService(
  backend: ProjectSpaceBackend,
  userId: string
) {
  const devServers = createDevServerService({
    backend,
    connector: {
      inspect: requestConnectorDevServerInspect,
      list: requestConnectorDevServerList,
      start: requestConnectorDevServerStart,
      stop: requestConnectorDevServerStop
    },
    database: {
      createDevServerSession,
      isConfigured: isDatabaseConfigured,
      isMachineClaimed,
      listDevServerSessions,
      readMachineMembership,
      readProjectRunSettings,
      transitionDevServerSession,
      upsertProjectRunSettings
    },
    userId: () => userId
  });

  const service = createPullRequestPrototypeIterationService({
    devServers,
    async inspectCodexTask(actorUserId, machineId, threadId) {
      codexRuntime ??= createConfiguredCodexSessionsRuntime();
      return (await codexRuntime).service.inspect(
        { userId: actorUserId },
        { machineId, threadId }
      );
    },
    async listCodexTasks(actorUserId, machineId) {
      codexRuntime ??= createConfiguredCodexSessionsRuntime();
      return (await codexRuntime).service.list(
        { userId: actorUserId },
        { includeArchived: false, machineId }
      );
    },
    listConnectorMachines: getRegisteredConnectorMachines,
    listPhysicalMachines: (actorUserId) => isDatabaseConfigured()
      ? listPhysicalMachines(actorUserId)
      : Promise.resolve([]),
    loadDiscovery: () => backend.loadProjectDiscovery(),
    loadRepository: (repositoryFullName) =>
      backend.getGitHubRepositoryDetails(repositoryFullName),
    loadWorktrees: (projectPath, machineId) =>
      backend.loadProjectWorktrees(projectPath, machineId),
    async register(input) {
      return registerConfiguredPullRequestDevServer({
        connectorId: input.identity.connectorId,
        machineId: input.identity.machineId,
        userId: input.userId
      }, {
        branchName: input.identity.branchName,
        codexThreadId: input.identity.codexTask.threadId,
        commitSha: input.identity.headSha,
        connectorId: input.identity.connectorId,
        machineId: input.identity.machineId,
        projectId: input.identity.projectId,
        pullRequestNumber: input.identity.pullRequestNumber,
        repositoryFullName: input.identity.repositoryFullName,
        runtime: input.runtime,
        servedSurface: input.identity.surface,
        serverId: input.identity.serverId,
        worktreeId: input.identity.worktreeId
      });
    },
    scheduleHeartbeat({ identity, lease, userId: actorUserId }) {
      const existing = heartbeatTimers.get(lease.id);
      if (existing) clearInterval(existing);
      const timer = setInterval(() => {
        void devServers.inspect({
          machineId: identity.connectorId,
          projectId: identity.projectId
        }).then((overview) => {
          const server = overview.servers.find((candidate) =>
            candidate.worktreeId === identity.worktreeId &&
            candidate.serverId === identity.serverId &&
            candidate.state === 'running'
          );
          if (!server?.tailscaleIPv4 || !server.publicPort) {
            throw new Error('The exact development server is no longer running.');
          }
          return heartbeatConfiguredPullRequestDevServer({
            connectorId: identity.connectorId,
            machineId: identity.machineId,
            userId: actorUserId
          }, {
            connectorId: identity.connectorId,
            generation: lease.generation,
            leaseId: lease.id,
            machineId: identity.machineId,
            runtime: {
              checkedAt: server.checkedAt,
              state: 'running',
              tailscaleIpv4: server.tailscaleIPv4,
              tailscalePort: server.publicPort
            },
            servedSurface: identity.surface
          });
        }).catch(() => {
          clearInterval(timer);
          heartbeatTimers.delete(lease.id);
        });
      }, 15_000);
      timer.unref();
      heartbeatTimers.set(lease.id, timer);
    }
  });

  return {
    read(
      request: PullRequestPrototypeIterationRequest,
      live?: Parameters<typeof service.read>[2]
    ) {
      return service.read(userId, request, live);
    },
    start(request: PullRequestPrototypeIterationRequest) {
      return service.start(userId, request);
    }
  };
}
