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
import { createProjectSpaceApiHandler } from './project-space-api-handler';
import {
  createProjectChatRuntime,
  type ProjectChatRuntime
} from './project-chat/runtime';
import { writeJson, writeText } from './project-space-http-response';
import { serveProjectSpaceStatic } from './project-space-static';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

interface ProjectSpaceHttpOptions {
  backend?: ProjectSpaceBackend;
  host?: string;
  port?: number;
  projectChatRuntime?: ProjectChatRuntime;
  staticRoot?: string;
}

export function createProjectSpaceRequestHandler(options: ProjectSpaceHttpOptions = {}) {
  const backend = createAuthorizedProjectSpaceBackend(
    options.backend ?? createLocalProjectSpaceBackend()
  );
  const projectChatRuntime = options.projectChatRuntime
    ? Promise.resolve(options.projectChatRuntime)
    : createProjectChatRuntime();
  const handleApiRequest = projectChatRuntime.then((runtime) =>
    createProjectSpaceApiHandler(backend, runtime)
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
  const projectChatRuntime = options.projectChatRuntime ?? await createProjectChatRuntime();
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
    authenticateConnectorCredential: authenticateConnectorMachineToken
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

  projectChatRuntime.start();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(options.port ?? 0, host, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    projectChatRuntime.stop();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Project Space backend did not expose a TCP address.');
  }

  return {
    close: async () => {
      projectChatRuntime.stop();
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
