import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createConnectorCommandUpgradeHandler } from './connector-command-hub';
import { createAuthorizedProjectSpaceBackend } from './authorized-project-space-backend';
import { connectorInstallScript, requestPublicOrigin } from './connector-installation';
import { resolveConnectorMachineTokenIdentity } from './connector-registration-auth';
import {
  createLocalProjectSpaceBackend,
  type LocalProjectSpaceBackend
} from './local-project-space-backend';
import {
  createMachineTerminalUpgradeHandler,
  createProjectTerminalUpgradeHandler
} from './machine-terminal-websocket';
import type { MachineConnectionRuntime } from './machine-connection-runtime';
import { createProjectSpaceApiHandler } from './project-space-api-handler';
import {
  createProjectChatRuntime,
  projectChatMachineAuthenticator,
  type ProjectChatRuntime
} from './project-chat/runtime';
import { writeJson, writeText } from './project-space-http-response';
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
  createConfiguredCodexAuthorizationHandler
} from './codex-authorization/configured-runtime';
import { createConfiguredRoadmapCliHandler } from './roadmap/roadmap-cli-runtime';
import {
  createConfiguredProjectCatalogCliHandler
} from './project-catalog/project-catalog-cli-runtime';
import {
  createPreviewDocsProxy,
  type PreviewDocsProxyDependencies
} from './preview-docs-proxy';
import { createProjectSpaceMcpHandler } from './project-space-mcp';

export interface ProjectSpaceHttpOptions {
  backend?: ProjectSpaceBackend;
  codexSessions?: CodexSessionsHttpHandler;
  codexAttachLeases?: CodexAttachLeaseStore;
  host?: string;
  machineConnectionRuntime?: MachineConnectionRuntime;
  port?: number;
  projectChatRuntime?: ProjectChatRuntime;
  previewDocsProxy?: PreviewDocsProxyDependencies;
  staticRoot?: string;
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
  const projectSpaceMcp = createProjectSpaceMcpHandler({
    backend,
    createRuntime: () => createConfiguredCodexMachineTasksRuntime({
      attachLeases: codexAttachLeases,
      backend: rawBackend,
      machineConnection: options.machineConnectionRuntime
    })
  });
  const codexAuthorization = createConfiguredCodexAuthorizationHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  const machineReadiness = createConfiguredMachineReadinessHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  const machinePower = createConfiguredMachinePowerHandler({
    machineConnection: options.machineConnectionRuntime
  });
  const roadmapCli = createConfiguredRoadmapCliHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  const projectCatalogCli = createConfiguredProjectCatalogCliHandler({
    backend: rawBackend,
    machineConnection: options.machineConnectionRuntime
  });
  const proxyPreviewDocs = createPreviewDocsProxy(
    process.env,
    options.previewDocsProxy
  );
  const handleApiRequest = projectChatRuntime.then((runtime) =>
    createProjectSpaceApiHandler(backend, {
      codexAuthorization,
      codexSessions,
      codexMachineTasks,
      machineReadiness,
      machinePower,
      machineConnection: options.machineConnectionRuntime,
      projectChat: runtime,
      projectCatalogCli,
      projectTopology,
      roadmapCli
    })
  );

  return async function handleProjectSpaceRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
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

    if (request.method === 'GET' && url.pathname === '/connector/install.sh') {
      writeText(
        response,
        200,
        connectorInstallScript(requestPublicOrigin(request)),
        'text/x-shellscript; charset=utf-8'
      );
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
  };
}

export async function createProjectSpaceServer(options: ProjectSpaceHttpOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const backend = options.backend ?? createLocalProjectSpaceBackend();
  const authorizedBackend = createAuthorizedProjectSpaceBackend(backend);
  const projectChatRuntime = await resolveProjectChatRuntime(options, backend);
  const machineConnectionRuntime = options.machineConnectionRuntime;
  const codexAttachLeases = options.codexAttachLeases ?? new CodexAttachLeaseStore();
  const server = createServer(
    createProjectSpaceRequestHandler({
      ...options,
      backend,
      codexAttachLeases,
      projectChatRuntime
    })
  );
  const handleMachineTerminalUpgrade = createMachineTerminalUpgradeHandler(authorizedBackend);
  const handleProjectTerminalUpgrade = createProjectTerminalUpgradeHandler();
  const connectorCommands = createConnectorCommandUpgradeHandler({
    async authenticateConnectorCredential(token, machineId) {
      const machineIdentity = machineConnectionRuntime
        ? typeof machineConnectionRuntime.resolveMachineCredentialIdentity === 'function'
          ? await machineConnectionRuntime.resolveMachineCredentialIdentity(token, machineId)
          : await machineConnectionRuntime.authenticateConnectorCredential(token, machineId)
            ? { machineId }
            : null
        : null;
      return machineIdentity ?? resolveConnectorMachineTokenIdentity(token, machineId);
    },
    async decideConnectorRuntimeMaintenance({ machine }) {
      const decideReconnect = (backend as Partial<LocalProjectSpaceBackend>).decideReconnect;
      if (!decideReconnect) return undefined;
      return decideReconnect(machine);
    }
  });
  const codexAttach = createCodexAttachUpgradeHandler(codexAttachLeases);

  server.on('upgrade', (request, socket, head) => {
    if (
      !codexAttach.handleUpgrade(request, socket, head) &&
      !connectorCommands.handleUpgrade(request, socket, head) &&
      !handleMachineTerminalUpgrade(request, socket, head) &&
      !handleProjectTerminalUpgrade(request, socket, head)
    ) {
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
    await connectorCommands.close();
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
      await connectorCommands.close();
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
