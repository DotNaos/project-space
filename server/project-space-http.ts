import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createConnectorCommandUpgradeHandler } from './connector-command-hub';
import { createAuthorizedProjectSpaceBackend } from './authorized-project-space-backend';
import { connectorInstallScript, requestPublicOrigin } from './connector-installation';
import { authenticateConnectorMachineToken } from './connector-registration-auth';
import { createLocalProjectSpaceBackend } from './local-project-space-backend';
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
import type { CodexSessionsHttpHandler } from './codex-sessions-http';
import { createConfiguredCodexSessionsHandler } from './codex-sessions/configured-runtime';

export interface ProjectSpaceHttpOptions {
  backend?: ProjectSpaceBackend;
  codexSessions?: CodexSessionsHttpHandler;
  host?: string;
  machineConnectionRuntime?: MachineConnectionRuntime;
  port?: number;
  projectChatRuntime?: ProjectChatRuntime;
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

export function createProjectSpaceRequestHandler(options: ProjectSpaceHttpOptions = {}) {
  const rawBackend = options.backend ?? createLocalProjectSpaceBackend();
  const backend = createAuthorizedProjectSpaceBackend(rawBackend);
  const projectChatRuntime = resolveProjectChatRuntime(options, rawBackend);
  const codexSessions = options.codexSessions ?? createConfiguredCodexSessionsHandler();
  const handleApiRequest = projectChatRuntime.then((runtime) =>
    createProjectSpaceApiHandler(backend, {
      codexSessions,
      machineConnection: options.machineConnectionRuntime,
      projectChat: runtime
    })
  );

  return async function handleProjectSpaceRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/connector/install.sh') {
      writeText(
        response,
        200,
        connectorInstallScript(requestPublicOrigin(request)),
        'text/x-shellscript; charset=utf-8'
      );
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
  const server = createServer(
    createProjectSpaceRequestHandler({
      ...options,
      backend,
      projectChatRuntime
    })
  );
  const handleMachineTerminalUpgrade = createMachineTerminalUpgradeHandler(authorizedBackend);
  const handleProjectTerminalUpgrade = createProjectTerminalUpgradeHandler();
  const connectorCommands = createConnectorCommandUpgradeHandler({
    async authenticateConnectorCredential(token, machineId) {
      if (
        machineConnectionRuntime &&
        await machineConnectionRuntime.authenticateConnectorCredential(token, machineId)
      ) {
        return true;
      }
      return authenticateConnectorMachineToken(token, machineId);
    }
  });

  server.on('upgrade', (request, socket, head) => {
    if (
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
