import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import electron from 'vite-plugin-electron/simple';

import { createLocalProjectSpaceBackend } from './server/local-project-space-backend';
import { reconcileProjectServeSessions } from './server/local-project-cli-client';
import { resolveProjectConnectorTargets } from './server/project-connector-config';
import { createAuthorizedProjectSpaceBackend } from './server/authorized-project-space-backend';
import { createConnectorCommandUpgradeHandler } from './server/connector-command-hub';
import { authenticateConnectorMachineToken } from './server/connector-registration-auth';
import {
  createMachineTerminalUpgradeHandler,
  createProjectTerminalUpgradeHandler
} from './server/machine-terminal-websocket';
import { startProjectConnectorWebSocket } from './server/project-connector-websocket';
import { createProjectSpaceRequestHandler } from './server/project-space-http';

const configuredAllowedHosts = (process.env.PROJECT_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const connectorBridgeEnabled = process.env.PROJECT_SPACE_ENABLE_CONNECTOR_BRIDGE === '1';

function projectSpaceApiPlugin(): Plugin {
  return {
    name: 'project-space-api',
    configureServer(server: ViteDevServer) {
      if (connectorBridgeEnabled && resolveProjectConnectorTargets().length > 0) {
        void reconcileProjectServeSessions();
      }
      const backend = createLocalProjectSpaceBackend();
      const authorizedBackend = createAuthorizedProjectSpaceBackend(backend);
      const bridge = connectorBridgeEnabled
        ? startProjectConnectorWebSocket({ backend })
        : undefined;
      const handler = createProjectSpaceRequestHandler({
        backend
      });
      const handleMachineTerminalUpgrade = createMachineTerminalUpgradeHandler(authorizedBackend);
      const handleProjectTerminalUpgrade = createProjectTerminalUpgradeHandler();
      const connectorCommands = createConnectorCommandUpgradeHandler({
        authenticateConnectorCredential: authenticateConnectorMachineToken
      });

      server.httpServer?.once('close', () => {
        bridge?.close();
        void connectorCommands.close();
      });

      server.httpServer?.on('upgrade', (request, socket, head) => {
        if (
          !connectorCommands.handleUpgrade(request, socket, head) &&
          !handleMachineTerminalUpgrade(request, socket, head) &&
          !handleProjectTerminalUpgrade(request, socket, head)
        ) {
          return;
        }
      });

      server.middlewares.use((
        request: IncomingMessage,
        response: ServerResponse,
        next: () => void
      ) => {
        if (!request.url?.startsWith('/api/')) {
          next();
          return;
        }

        void handler(request, response);
      });
    }
  };
}

export default defineConfig(({ command, mode }) => {
  if (
    command === 'serve' &&
    !process.env.PORTLESS_URL &&
    process.env.PROJECT_SPACE_ALLOW_DIRECT_DEV !== '1'
  ) {
    throw new Error(
      'Project Space dev servers must run through Portless. Use `bun run dev`, or `bun run dev:direct` only for exceptional local debugging.'
    );
  }

  return ({
  plugins: [
    react(),
    tailwindcss(),
    projectSpaceApiPlugin(),
    mode === 'electron'
      ? electron({
          main: {
            entry: 'electron/main/index.ts',
            vite: {
              build: {
                outDir: 'dist-electron/main',
                rollupOptions: {
                  output: {
                    entryFileNames: 'index.js'
                  }
                }
              }
            }
          },
          renderer: {}
        })
      : null
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    ...(configuredAllowedHosts.length > 0 ? { allowedHosts: configuredAllowedHosts } : {}),
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true
  }
  });
});
