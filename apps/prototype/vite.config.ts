import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const prototypeRoot = resolve(import.meta.dirname);
const repositoryRoot = resolve(prototypeRoot, '../..');

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
    plugins: [react(), tailwindcss()],
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
