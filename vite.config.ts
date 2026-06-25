import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import electron from 'vite-plugin-electron/simple';

import { createProjectSpaceRequestHandler } from './server/project-space-http';

function projectSpaceApiPlugin(): Plugin {
  return {
    name: 'project-space-api',
    configureServer(server: ViteDevServer) {
      const handler = createProjectSpaceRequestHandler();

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

export default defineConfig(({ mode }) => ({
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
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true
  }
}));
