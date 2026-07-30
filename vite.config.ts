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
import { writeJson } from './server/project-space-http-response';
import { createPrototypeReviewLocalRuntime } from './server/prototype-review-local-runtime';
import { readReleaseCatalog } from './apps/docs/lib/releases/catalog';
import { generatedReleaseChangelogSource } from './apps/docs/lib/releases/changelog-source';

const configuredAllowedHosts = (process.env.PROJECT_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const connectorBridgeEnabled = process.env.PROJECT_SPACE_ENABLE_CONNECTOR_BRIDGE === '1';

function releaseChangelogSourceForBuild() {
  const catalog = readReleaseCatalog(resolve(
    __dirname,
    'apps/docs/content/docs/releases/entries'
  ));
  if (!catalog.ok) {
    throw new Error(
      `Release changelog source is invalid:\n${catalog.errors.join('\n')}`
    );
  }
  return generatedReleaseChangelogSource(catalog.catalog.entries);
}

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
      const localReviewRuntime = createPrototypeReviewLocalRuntime({
        backend,
        repositoryRoot: __dirname
      });
      const handler = createProjectSpaceRequestHandler({
        backend,
        codexSessions: async (request, response, url) => (
          (await localReviewRuntime).codexSessions(request, response, url)
        )
      });
      const handleMachineTerminalUpgrade = createMachineTerminalUpgradeHandler(authorizedBackend);
      const handleProjectTerminalUpgrade = createProjectTerminalUpgradeHandler();
      const connectorCommands = createConnectorCommandUpgradeHandler({
        authenticateConnectorCredential: authenticateConnectorMachineToken
      });

      server.httpServer?.once('close', () => {
        bridge?.close();
        void connectorCommands.close();
        void localReviewRuntime.then((runtime) => runtime.close());
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

        const url = new URL(request.url, 'http://127.0.0.1');
        if (
          request.method === 'GET' &&
          url.pathname === '/api/prototype-review/local-context'
        ) {
          void localReviewRuntime
            .then((runtime) => runtime.readContext(
              url.searchParams.get('repository')?.trim() || undefined,
              positiveInteger(url.searchParams.get('pr'))
            ))
            .then((context) => writeJson(response, 200, context))
            .catch(() => writeJson(response, 503, {
              checkedAt: new Date().toISOString(),
              checkout: { reason: 'checkout-unavailable', state: 'unavailable' },
              codex: { reason: 'codex-unavailable', state: 'unavailable' }
            }));
          return;
        }
        if (url.pathname.startsWith('/api/prototype-review/codex-images')) {
          void localReviewRuntime
            .then((runtime) => runtime.codexImages(request, response, url))
            .then((handled) => {
              if (!handled) writeJson(response, 404, { error: 'Route not found.' });
            })
            .catch(() => writeJson(response, 503, {
              error: 'The local image attachment service is temporarily unavailable.'
            }));
          return;
        }
        if (url.pathname === '/api/prototype-review/codex-models') {
          void localReviewRuntime
            .then((runtime) => runtime.codexModels(request, response, url))
            .then((handled) => {
              if (!handled) writeJson(response, 404, { error: 'Route not found.' });
            })
            .catch(() => writeJson(response, 503, {
              error: 'Codex model settings are temporarily unavailable.'
            }));
          return;
        }
        if (url.pathname.startsWith('/api/codex/sessions')) {
          void localReviewRuntime
            .then((runtime) => runtime.codexSessions(request, response, url))
            .then((handled) => {
              if (!handled) writeJson(response, 404, { error: 'Route not found.' });
            })
            .catch(() => writeJson(response, 503, {
              error: 'The local Codex task is temporarily unavailable.'
            }));
          return;
        }

        void handler(request, response);
      });
    }
  };
}

function positiveInteger(value: string | null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
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
  define: {
    __PROJECT_RELEASE_CHANGELOG_SOURCE__: JSON.stringify(
      releaseChangelogSourceForBuild()
    )
  },
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
