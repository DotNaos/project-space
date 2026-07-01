import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import electron from 'vite-plugin-electron/simple';

import { createLocalProjectSpaceBackend } from './server/local-project-space-backend';
import { createMachineTerminalUpgradeHandler } from './server/machine-terminal-websocket';
import { createProjectSpaceRequestHandler } from './server/project-space-http';

function projectSpaceApiPlugin(): Plugin {
  return {
    name: 'project-space-api',
    configureServer(server: ViteDevServer) {
      const backend = createLocalProjectSpaceBackend();
      const handler = createProjectSpaceRequestHandler({
        backend
      });
      const handleMachineTerminalUpgrade = createMachineTerminalUpgradeHandler(backend);

      server.httpServer?.on('upgrade', (request, socket, head) => {
        handleMachineTerminalUpgrade(request, socket, head);
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
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true
  }
}));
