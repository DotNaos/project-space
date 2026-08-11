import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

import { readReleaseCatalog } from '../docs/lib/releases/catalog';
import { generatedReleaseChangelogSource } from '../docs/lib/releases/changelog-source';
import { prototypeReviewLocalApiPlugin } from '../../server/prototype-review-local-vite-plugin';
import { machineRuntimePrototypeConnectors } from './src/project-space-pages/machine-runtime-fixtures';

const prototypeRoot = resolve(import.meta.dirname);
const repositoryRoot = resolve(prototypeRoot, '../..');

function releaseChangelogSourceForBuild() {
  const catalog = readReleaseCatalog(resolve(
    repositoryRoot,
    'apps/docs/content/docs/releases/entries'
  ));
  if (!catalog.ok) {
    throw new Error(
      `Release changelog source is invalid:\n${catalog.errors.join('\n')}`
    );
  }
  return generatedReleaseChangelogSource(catalog.catalog.entries);
}

function prototypeMachineRuntimeApiPlugin(): Plugin {
  return {
    name: 'prototype-machine-runtime-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' || !request.url) {
          next();
          return;
        }
        const url = new URL(request.url, 'http://127.0.0.1');
        const match = /^\/api\/machines\/([^/]+)\/runtime$/.exec(url.pathname);
        if (!match) {
          next();
          return;
        }
        const machineId = decodeURIComponent(match[1]!);
        const machine = machineRuntimePrototypeConnectors.find(
          (candidate) => candidate.id === machineId
        );
        if (!machine) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({
          capabilities: machine.connector.capabilities ?? [],
          machineId,
          online: machine.connector.status === 'online',
          runtime: machine.connector.runtime,
          update: machine.connector.update ?? { state: 'unknown' }
        }));
      });
    }
  };
}

export default defineConfig(({ command }) => {
  if (
    command === 'serve' &&
    !process.env.PORTLESS_URL &&
    process.env.PROJECT_SPACE_ALLOW_DIRECT_DEV !== '1'
  ) {
    throw new Error(
      'Prototype dev servers must run through Portless. Use `bun run dev:prototype`, or `bun run dev:prototype:direct` only for exceptional local debugging.'
    );
  }

  const mobilePrototypeOrigin =
    process.env.PROJECT_SPACE_PROTOTYPE_MOBILE_ORIGIN;
  const mobilePrototypeProxy = mobilePrototypeOrigin
    ? {
        changeOrigin: false,
        target: mobilePrototypeOrigin,
        ws: true
      }
    : null;

  return {
    base: '/prototype/desktop/',
    define: {
      __PROJECT_RELEASE_CHANGELOG_SOURCE__: JSON.stringify(
        releaseChangelogSourceForBuild()
      )
    },
    plugins: [
      react(),
      tailwindcss(),
      prototypeMachineRuntimeApiPlugin(),
      prototypeReviewLocalApiPlugin(repositoryRoot)
    ],
    resolve: {
      alias: {
        '@': resolve(repositoryRoot, 'src')
      }
    },
    root: prototypeRoot,
    server: {
      port: process.env.PORT ? Number(process.env.PORT) : 5180,
      proxy: mobilePrototypeProxy
        ? {
            '/_expo': mobilePrototypeProxy,
            '/assets': mobilePrototypeProxy,
            '/index.ts.bundle': mobilePrototypeProxy,
            '/prototype/mobile': mobilePrototypeProxy
          }
        : undefined,
      strictPort: true
    },
    build: {
      emptyOutDir: true,
      outDir: resolve(prototypeRoot, 'dist')
    }
  };
});
