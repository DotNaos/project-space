import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createAuthorizedProjectSpaceBackend } from './authorized-project-space-backend';
import { createLocalProjectSpaceBackend } from './local-project-space-backend';
import { createProjectTerminalUpgradeHandler } from './machine-terminal-websocket';
import type { MachineConnectionRuntime } from './machine-connection-runtime';
import { createProjectSpaceApiHandler } from './project-space-api-handler';
import {
  createProjectChatRuntime,
  projectChatMachineAuthenticator,
  type ProjectChatRuntime
} from './project-chat/runtime';
import { writeJson } from './project-space-http-response';
import { serveProjectSpaceStatic } from './project-space-static';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import { previewPullRequestNumberFromHostname } from '../src/shared/preview-host';
import type { CodexSessionsHttpHandler } from './codex-sessions-http';
import { createConfiguredCodexSessionsHandler } from './codex-sessions/configured-runtime';
import { createProjectTopologyInventoryService } from './project-topology/project-inventory-service';
import { createProjectTopologyInventoryHttpHandler } from './project-topology/project-inventory-http';
import {
  createConfiguredCodexMachineTasksHandler,
  createConfiguredCodexMachineTasksRuntime
} from './codex-machine-tasks/configured-runtime';
import { CodexAttachLeaseStore } from './codex-machine-tasks/attach-lease-store';
import { createCodexAttachUpgradeHandler } from './codex-machine-tasks/attach-websocket';
import {
  createConfiguredMachineReadinessHandler
} from './machine-readiness/configured-runtime';
import {
  createConfiguredMachinePowerHandler
} from './machine-power/configured-runtime';
import {
  createConfiguredCodexAuthorizationHandler,
  createConfiguredCodexAuthorizationRuntime
} from './codex-authorization/configured-runtime';
import { createConfiguredAgentRuntime } from './agent-authorization/configured-runtime';
import { createGitHubCodespaceRunnerHttpHandler } from './github-codespace-runner/http';
import { createConfiguredGitHubCodespaceRunnerRuntime } from './github-codespace-runner/configured-runtime';
import {
  createConfiguredExecutionEnvironmentLifecycle
} from './execution-environment-lifecycle/configured-runtime';
import { createConfiguredRoadmapCliHandler } from './roadmap/roadmap-cli-runtime';
import {
  createConfiguredProjectCatalogCliHandler
} from './project-catalog/project-catalog-cli-runtime';
import {
  createConfiguredComputeInventoryCliHandler
} from './compute-inventory-cli/configured-runtime';
import {
  createConfiguredSshControlGatewayHandler
} from './ssh-control-gateway/configured-runtime';
import {
  createPreviewDocsProxy,
  type PreviewDocsProxyDependencies
} from './preview-docs-proxy';
import { createProjectSpaceMcpHandler } from './project-space-mcp';
import { createConfiguredTaskExecutionService } from './task-execution/configured-runtime';
import { createConfiguredTaskDeliveryService } from './task-delivery/configured-runtime';
import { createConfiguredWorkspaceCommandService } from './workspace-command/configured-runtime';
import { observeHttpRequest } from './http-observability';
import {
  projectSpaceLogger,
  recordObservedError,
  type ProjectSpaceLogger
} from './observability';
import { MemoryRuntimeSessionStore } from './workspace-runtime-session/memory-store';
import { WorkspaceRuntimeSessionService } from './workspace-runtime-session/service';
import { createWorkspaceRuntimeSessionUpgradeHandler } from './workspace-runtime-session/upgrade-handler';
import { PostgresRuntimeSessionStore } from './workspace-runtime-session/postgres-store';
import { getMachineConnectionDatabaseClient, isDatabaseConfigured } from './local-database-store';
import { MemoryProjectHostdStore } from './project-hostd/memory-store';
import { PostgresProjectHostdStore } from './project-hostd/postgres-store';
import {
  createConfiguredProjectHostdRuntime
} from './project-hostd/configured-runtime';
import { createConfiguredHostControlHandler } from './host-control/configured-runtime';
import {
  handleRetiredConnectorHttp,
  rejectRetiredConnectorUpgrade,
  rejectRetiredMachineTerminalUpgrade
} from './legacy-connector-retirement';
import {
  createCanonicalRuntimeControlRuntime,
  createConfiguredCanonicalRuntimeControlHandler
} from './canonical-runtime-control/configured-runtime';
import { PostgresCanonicalRuntimeControlOperationStore } from './canonical-runtime-control/postgres-operation-store';
import type { createCanonicalRuntimeControlHttpApi } from './canonical-runtime-control/http';
import { createConfiguredTailscaleInventoryHandler } from './tailscale-inventory/configured-runtime';

export interface ProjectSpaceHttpOptions {
  backend?: ProjectSpaceBackend;
  codexSessions?: CodexSessionsHttpHandler;
  canonicalRuntimeControl?: ReturnType<typeof createCanonicalRuntimeControlHttpApi>;
  codexAttachLeases?: CodexAttachLeaseStore;
  host?: string;
  machineConnectionRuntime?: MachineConnectionRuntime;
  logger?: ProjectSpaceLogger;
  port?: number;
  projectChatRuntime?: ProjectChatRuntime;
  previewDocsProxy?: PreviewDocsProxyDependencies;
  staticRoot?: string;
  workspaceRuntimeSessions?: WorkspaceRuntimeSessionService;
  projectHostd?: ReturnType<typeof createConfiguredProjectHostdRuntime>['handleRequest'];
  projectHostdInventory?: Pick<
    ReturnType<typeof createConfiguredProjectHostdRuntime>['service'],
    'list'
  >;
}

function resolveProjectChatRuntime(
  options: ProjectSpaceHttpOptions,
  backend: ProjectSpaceBackend
) {
  if (options.projectChatRuntime) {
    return Promise.resolve(options.projectChatRuntime);
  }
  return createProjectChatRuntime({
    authenticateMachine: projectChatMachineAuthenticator(options.machineConnectionRuntime),
    backend
  });
}

export function previewHubRedirectForOfflineHost(hostname: string, pathname: string, search = '') {
  const pullRequestNumber = previewPullRequestNumberFromHostname(hostname.replace(/:\d+$/, '').toLowerCase());
  if (pullRequestNumber === undefined) return undefined;
  const target = new URL('https://pr.projects.os-home.net/');
  target.searchParams.set('pr', String(pullRequestNumber));
  const returnTarget = `${pathname || '/'}${search}`;
  if (returnTarget.startsWith('/') && !returnTarget.startsWith('//') && !/[\u0000-\u001f\u007f]/.test(returnTarget)) {
    target.searchParams.set('return', returnTarget.slice(0, 2_048));
  }
  return target.toString();
}

export function createProjectSpaceRequestHandler(options: ProjectSpaceHttpOptions = {}) {
  const logger = options.logger ?? projectSpaceLogger.child({ component: 'http' });
  const rawBackend = options.backend ?? createLocalProjectSpaceBackend();
  const backend = createAuthorizedProjectSpaceBackend(rawBackend);
  const projectTopology = createProjectTopologyInventoryHttpHandler(
    createProjectTopologyInventoryService({
      authorizedBackend: backend,
      worktreeBackend: rawBackend
    })
  );
  const projectChatRuntime = resolveProjectChatRuntime(options, rawBackend);
  const codexSessions = options.codexSessions ?? createConfiguredCodexSessionsHandler();
  const codexAttachLeases = options.codexAttachLeases ?? new CodexAttachLeaseStore();
  const codexMachineTasks = createConfiguredCodexMachineTasksHandler({
    attachLeases: codexAttachLeases,
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  let mcpCodexRuntime: ReturnType<typeof createConfiguredCodexMachineTasksRuntime> | undefined;
  const getMcpCodexRuntime = () => (
    mcpCodexRuntime ??= createConfiguredCodexMachineTasksRuntime({
      attachLeases: codexAttachLeases,
      backend: rawBackend,
      machineConnection: options.machineConnectionRuntime
    }).catch((error) => {
      mcpCodexRuntime = undefined;
      throw error;
    })
  );
  const githubCodespaceRunnerRuntime = createConfiguredGitHubCodespaceRunnerRuntime({
    backend: rawBackend
  });
  const codexAuthorizationRuntime = createConfiguredCodexAuthorizationRuntime({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  let mcpAgentRuntime: ReturnType<typeof createConfiguredAgentRuntime> | undefined;
  const getMcpAgentRuntime = () => (
    mcpAgentRuntime ??= createConfiguredAgentRuntime({
      authorization: codexAuthorizationRuntime,
      backend
    }).catch((error) => {
      mcpAgentRuntime = undefined;
      throw error;
    })
  );
  let mcpEnvironmentLifecycle: ReturnType<
    typeof createConfiguredExecutionEnvironmentLifecycle
  > | undefined;
  const getMcpEnvironmentLifecycle = () => (
    mcpEnvironmentLifecycle ??= createConfiguredExecutionEnvironmentLifecycle({
      backend,
      createCodexRuntime: getMcpCodexRuntime,
      githubCodespaceRunnerRuntime
    }).catch((error) => {
      mcpEnvironmentLifecycle = undefined;
      throw error;
    })
  );
  let mcpTaskExecutions: ReturnType<typeof createConfiguredTaskExecutionService> | undefined;
  const getMcpTaskExecutions = () => (
    mcpTaskExecutions ??= Promise.all([
      getMcpAgentRuntime(),
      getMcpCodexRuntime(),
      getMcpEnvironmentLifecycle()
    ]).then(([agentRuntime, codex, environmentLifecycle]) => (
      createConfiguredTaskExecutionService({
        agentRuntime,
        backend,
        codex,
        environmentLifecycle
      })
    )).catch((error) => {
      mcpTaskExecutions = undefined;
      throw error;
    })
  );
  let mcpTaskDelivery: ReturnType<typeof createConfiguredTaskDeliveryService> | undefined;
  const getMcpTaskDelivery = () => (
    mcpTaskDelivery ??= getMcpTaskExecutions().then((taskExecutions) => (
      createConfiguredTaskDeliveryService({ backend, taskExecutions })
    )).catch((error) => {
      mcpTaskDelivery = undefined;
      throw error;
    })
  );
  let mcpWorkspaceCommands: ReturnType<typeof createConfiguredWorkspaceCommandService> | undefined;
  const getMcpWorkspaceCommands = () => (
    mcpWorkspaceCommands ??= createConfiguredWorkspaceCommandService({
      backend,
      githubCodespaceRunnerRuntime
    }).catch((error) => {
      mcpWorkspaceCommands = undefined;
      throw error;
    })
  );
  const projectSpaceMcp = createProjectSpaceMcpHandler({
    backend,
    createAgentRuntime: getMcpAgentRuntime,
    createEnvironmentLifecycle: getMcpEnvironmentLifecycle,
    createTaskDelivery: getMcpTaskDelivery,
    createTaskExecutions: getMcpTaskExecutions,
    createWorkspaceCommands: getMcpWorkspaceCommands,
    createRuntime: getMcpCodexRuntime,
    logger
  });
  const codexAuthorization = createConfiguredCodexAuthorizationHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime,
    runtime: codexAuthorizationRuntime
  });
  const githubCodespaceRunner = createGitHubCodespaceRunnerHttpHandler({
    runtime: githubCodespaceRunnerRuntime
  });
  const machineReadiness = createConfiguredMachineReadinessHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  const machinePower = createConfiguredMachinePowerHandler({
    machineConnection: options.machineConnectionRuntime
  });
  const hostControl = createConfiguredHostControlHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  const canonicalRuntimeControl = options.canonicalRuntimeControl ??
    createConfiguredCanonicalRuntimeControlHandler({
    machineConnection: options.machineConnectionRuntime,
    runtimeSessions: options.workspaceRuntimeSessions
  });
  const roadmapCli = createConfiguredRoadmapCliHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  const projectCatalogCli = createConfiguredProjectCatalogCliHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  const computeInventoryCli = createConfiguredComputeInventoryCliHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime,
    projectHostd: options.projectHostdInventory,
    runtimeSessions: options.workspaceRuntimeSessions
  });
  const tailscaleInventory = createConfiguredTailscaleInventoryHandler({
    machineConnection: options.machineConnectionRuntime
  });
  const sshControlGateway = createConfiguredSshControlGatewayHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime,
    runtimeSessions: options.workspaceRuntimeSessions
  });
  const proxyPreviewDocs = createPreviewDocsProxy(
    process.env,
    options.previewDocsProxy
  );
  const handleApiRequest = projectChatRuntime.then((runtime) =>
    createProjectSpaceApiHandler(backend, {
      canonicalRuntimeControl,
      codexAuthorization,
      codexSessions,
      codexMachineTasks,
      computeInventoryCli,
      githubCodespaceRunner,
      hostControl,
      machineReadiness,
      machinePower,
      machineConnection: options.machineConnectionRuntime,
      projectChat: runtime,
      projectCatalogCli,
      projectHostd: options.projectHostd,
      projectTopology,
      roadmapCli,
      sshControlGateway,
      tailscaleInventory
    })
  );

  return async function handleProjectSpaceRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    await observeHttpRequest(request, response, async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      const offlinePreviewRedirect = previewHubRedirectForOfflineHost(
        String(request.headers.host ?? ''),
        url.pathname,
        url.search
      );
      if (offlinePreviewRedirect) {
        response.writeHead(302, { 'Cache-Control': 'no-store', Location: offlinePreviewRedirect }).end();
        return;
      }

      if (handleRetiredConnectorHttp(request, response, url)) {
        return;
      }

      if (await projectSpaceMcp(request, response, url)) {
        return;
      }

      if (await proxyPreviewDocs(request, response, url)) {
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const handled = await (await handleApiRequest)(request, response, url);
        if (!handled) {
          writeJson(response, 404, { error: 'Route not found.' });
        }
        return;
      }

      if (options.staticRoot) {
        serveProjectSpaceStatic(response, options.staticRoot, url.pathname);
        return;
      }

      writeJson(response, 404, { error: 'Route not found.' });
    }, logger);
  };
}

export async function createProjectSpaceServer(options: ProjectSpaceHttpOptions = {}) {
  const logger = options.logger ?? projectSpaceLogger.child({ component: 'server' });
  const host = options.host ?? '127.0.0.1';
  const backend = options.backend ?? createLocalProjectSpaceBackend();
  const projectChatRuntime = await resolveProjectChatRuntime(options, backend);
  const machineConnectionRuntime = options.machineConnectionRuntime;
  const codexAttachLeases = options.codexAttachLeases ?? new CodexAttachLeaseStore();
  const database = isDatabaseConfigured()
    ? await getMachineConnectionDatabaseClient()
    : undefined;
  const runtimeControlOperations = database
    ? new PostgresCanonicalRuntimeControlOperationStore(database)
    : undefined;
  const workspaceRuntimeSessionService = options.workspaceRuntimeSessions ??
    new WorkspaceRuntimeSessionService(
      database ? new PostgresRuntimeSessionStore(database) : new MemoryRuntimeSessionStore(),
      undefined,
      undefined,
      runtimeControlOperations ? { read: (...args) => runtimeControlOperations.watermarks(...args) } : undefined
    );
  const projectHostdStore = database
    ? new PostgresProjectHostdStore(database)
    : new MemoryProjectHostdStore();
  const projectHostd = createConfiguredProjectHostdRuntime({
    backend,
    machineConnection: options.machineConnectionRuntime,
    runtimeSessions: workspaceRuntimeSessionService,
    store: projectHostdStore
  });
  const canonicalRuntimeControl = runtimeControlOperations
    ? createCanonicalRuntimeControlRuntime({
      machineConnection: options.machineConnectionRuntime,
      operations: runtimeControlOperations,
      runtimeSessions: workspaceRuntimeSessionService,
      taskExecutions: database
      })
    : undefined;
  const server = createServer(
    createProjectSpaceRequestHandler({
      ...options,
      backend,
      codexAttachLeases,
      canonicalRuntimeControl: canonicalRuntimeControl?.handleRequest,
      logger,
      projectChatRuntime,
      workspaceRuntimeSessions: workspaceRuntimeSessionService,
      projectHostd: projectHostd.handleRequest,
      projectHostdInventory: projectHostd.service
    })
  );
  const handleProjectTerminalUpgrade = createProjectTerminalUpgradeHandler();
  const codexAttach = createCodexAttachUpgradeHandler(codexAttachLeases);
  const workspaceRuntimeSessions = createWorkspaceRuntimeSessionUpgradeHandler(
    workspaceRuntimeSessionService
  );
  const staleRuntimeSessions = setInterval(() => {
    void workspaceRuntimeSessionService.expireStale();
  }, 15_000);
  const staleProjectHostd = setInterval(() => {
    void Promise.all([
      projectHostd.service.expireStale(),
      projectHostd.service.pruneExpired()
    ]).catch((error) => {
      logger.error('project-hostd.maintenance.failed', {}, error);
    });
  }, 30_000);

  server.on('upgrade', (request, socket, head) => {
    try {
      if (
        !codexAttach.handleUpgrade(request, socket, head) &&
        !workspaceRuntimeSessions.handleUpgrade(request, socket, head) &&
        !rejectRetiredConnectorUpgrade(request, socket) &&
        !rejectRetiredMachineTerminalUpgrade(request, socket) &&
        !handleProjectTerminalUpgrade(request, socket, head)
      ) {
        socket.destroy();
      }
    } catch (error) {
      recordObservedError('websocket', 'upgrade_failed');
      logger.error('websocket.upgrade.failed', {
        route: new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      }, error);
      socket.destroy();
    }
  });

  try {
    projectChatRuntime.start();
    machineConnectionRuntime?.start();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(options.port ?? 0, host, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    projectChatRuntime.stop();
    await machineConnectionRuntime?.stop();
    codexAttach.close();
    clearInterval(staleRuntimeSessions);
    clearInterval(staleProjectHostd);
    await workspaceRuntimeSessions.close();
    canonicalRuntimeControl?.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Project Space backend did not expose a TCP address.');
  }

  return {
    close: async () => {
      projectChatRuntime.stop();
      await machineConnectionRuntime?.stop();
      codexAttach.close();
      clearInterval(staleRuntimeSessions);
      clearInterval(staleProjectHostd);
      await workspaceRuntimeSessions.close();
      canonicalRuntimeControl?.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        let settled = false;
        const finish = (error?: Error | null) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(closeFallback);
          if (error) {
            rejectClose(error);
          } else {
            resolveClose();
          }
        };
        const closeFallback = setTimeout(() => {
          if (!server.listening) {
            finish();
          } else {
            finish(new Error('Project Space server did not close.'));
          }
        }, 250);
        server.close((error) => {
          finish(error);
        });
      });
    },
    origin: `http://${host}:${address.port}`,
    server
  };
}
