import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';

import {
  createLocalProjectSpaceBackend
} from './server/local-project-space-backend';
import { createAuthorizedProjectSpaceBackend } from './server/authorized-project-space-backend';
import {
  createMachineTerminalUpgradeHandler,
  createProjectTerminalUpgradeHandler
} from './server/machine-terminal-websocket';
import { createProjectSpaceRequestHandler } from './server/project-space-http';
import { writeJson } from './server/project-space-http-response';
import { createPrototypeReviewLocalRuntime } from './server/prototype-review-local-runtime';
import { createConfiguredMachineConnectionRuntime } from './server/machine-connection-runtime';
import { deriveMachineConnectionPublicOrigin } from './server/machine-connection-environment';
import { readReleaseCatalog } from './apps/docs/lib/releases/catalog';
import { generatedReleaseChangelogSource } from './apps/docs/lib/releases/changelog-source';
import { createLocalSimulationRequestHandler } from './server/local-simulation/http';
import { installOutboundNetworkGuard } from './server/outbound-network-guard';
import {
  resolveManagedRuntimeBinding,
  type RuntimeBindingEvidence
} from './server/runtime-binding';

const configuredAllowedHosts = (process.env.PROJECT_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
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

function projectSpaceApiPlugin(binding: RuntimeBindingEvidence): Plugin {
  return {
    name: 'project-space-api',
    transformIndexHtml(html) {
      if (binding.apis !== 'simulated') return html;
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/>/,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:;" />`
      );
    },
    configureServer(server: ViteDevServer) {
      if (binding.apis === 'simulated') {
        const removeNetworkGuard = installOutboundNetworkGuard();
        const handleSimulationRequest = createLocalSimulationRequestHandler({
          binding,
          repositoryRoot: __dirname
        });
        server.httpServer?.once('close', removeNetworkGuard);
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/api/')) {
            next();
            return;
          }
          void handleSimulationRequest(request, response).catch((error) => {
            writeJson(response, 500, {
              error: error instanceof Error ? error.message : 'Local simulation failed.'
            });
          });
        });
        return;
      }

      const backend = createLocalProjectSpaceBackend();
      const authorizedBackend = createAuthorizedProjectSpaceBackend(backend);
      const localReviewRuntime = createPrototypeReviewLocalRuntime({
        repositoryRoot: __dirname
      });
      const machineConnectionRuntime = createConfiguredMachineConnectionRuntime({
        ...process.env,
        PROJECT_SPACE_PUBLIC_ORIGIN:
          process.env.PROJECT_SPACE_PUBLIC_ORIGIN ||
          deriveMachineConnectionPublicOrigin(
            process.env.PROJECT_SPACE_RUNTIME_ACCESS_URL
          ) ||
          (binding.network === 'loopback-only'
            ? deriveMachineConnectionPublicOrigin(process.env.PORTLESS_URL)
            : undefined) || undefined,
        PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET:
          process.env.PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET ??
          (process.env.PORTLESS_URL || process.env.PROJECT_SPACE_AUTH_DISABLED === '1'
            ? randomBytes(32).toString('hex')
            : undefined)
      });
      const handler = machineConnectionRuntime.then((runtime) => {
        runtime?.start();
        return createProjectSpaceRequestHandler({
          backend,
          machineConnectionRuntime: runtime ?? undefined
        });
      });
      const handleMachineTerminalUpgrade = createMachineTerminalUpgradeHandler(authorizedBackend);
      const handleProjectTerminalUpgrade = createProjectTerminalUpgradeHandler();
      server.httpServer?.once('close', () => {
        void localReviewRuntime.then((runtime) => runtime.close());
        void machineConnectionRuntime.then((runtime) => runtime?.stop());
      });

      server.httpServer?.on('upgrade', (request, socket, head) => {
        if (
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
        if (
          url.pathname.startsWith('/api/codex/sessions') &&
          request.headers['x-project-space-codex-surface'] === 'prototype-review'
        ) {
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

        void handler.then((handleRequest) => handleRequest(request, response));
      });
    }
  };
}

function positiveInteger(value: string | null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export default defineConfig(({ command }) => {
  if (
    command === 'serve' &&
    process.env.PROJECT_SPACE_MANAGED_SERVE !== '1'
  ) {
    throw new Error(
      'Project Space dev servers are managed by the Project CLI. Use `project serve dev`, or `project serve dev --local-only` for the explicit local fallback.'
    );
  }

  const binding = command === 'serve' ? resolveManagedRuntimeBinding() : undefined;

  return ({
  define: {
    __PROJECT_RELEASE_CHANGELOG_SOURCE__: JSON.stringify(
      releaseChangelogSourceForBuild()
    )
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(binding ? [projectSpaceApiPlugin(binding)] : [])
  ],
  resolve: {
    alias: {
      ...(command === 'build' ? {
        '@dotnaos/ui/code-editor': resolve(__dirname, 'src/components/ui/dotnaos-ui-code-editor-build-stub.ts'),
        '@dotnaos/ui/devtools': resolve(__dirname, 'src/components/ui/dotnaos-ui-devtools-build-stub.tsx')
      } : {}),
      '@': resolve(__dirname, 'src')
    },
    dedupe: ['react', 'react-dom']
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
