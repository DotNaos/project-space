import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import { readReleaseCatalog } from '../docs/lib/releases/catalog';
import { generatedReleaseChangelogSource } from '../docs/lib/releases/changelog-source';
import { prototypeReviewLocalApiPlugin } from '../../server/prototype-review-local-vite-plugin';

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

export default defineConfig(({ command }) => {
  if (
    command === 'serve' &&
    process.env.PROJECT_SPACE_MANAGED_SERVE !== '1'
  ) {
    throw new Error(
      'Prototype dev servers are managed by the Project CLI. Use `project serve prototype-desktop`, or add `--local-only` for the explicit local fallback.'
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
    plugins: [react(), tailwindcss(), prototypeReviewLocalApiPlugin(repositoryRoot)],
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
