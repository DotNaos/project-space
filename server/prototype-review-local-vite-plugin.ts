import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Plugin, ViteDevServer } from 'vite';

import { createLocalProjectSpaceBackend } from './local-project-space-backend';
import { writeJson } from './project-space-http-response';
import { createPrototypeReviewLocalRuntime } from './prototype-review-local-runtime';
import { createPrototypeReviewLocalChangelogHandler } from './prototype-review-local-changelog';

function positiveInteger(value: string | null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function prototypeReviewLocalApiPlugin(repositoryRoot: string): Plugin {
  return {
    name: 'prototype-review-local-api',
    configureServer(server: ViteDevServer) {
      const runtime = createPrototypeReviewLocalRuntime({
        backend: createLocalProjectSpaceBackend(),
        repositoryRoot
      });
      const changelog = createPrototypeReviewLocalChangelogHandler(repositoryRoot);

      server.httpServer?.once('close', () => {
        void runtime.then((value) => value.close());
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
        if (url.pathname === '/api/prototype-review/local-changelog') {
          void changelog(request, response, url)
            .then((handled) => {
              if (!handled) writeJson(response, 404, { error: 'Route not found.' });
            })
            .catch(() => writeJson(response, 503, {
              error: 'The local changelog is temporarily unavailable.'
            }));
          return;
        }
        if (
          request.method === 'GET' &&
          url.pathname === '/api/prototype-review/local-context'
        ) {
          void runtime
            .then((value) => value.readContext(
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
          void runtime
            .then((value) => value.codexImages(request, response, url))
            .then((handled) => {
              if (!handled) writeJson(response, 404, { error: 'Route not found.' });
            })
            .catch(() => writeJson(response, 503, {
              error: 'The local image attachment service is temporarily unavailable.'
            }));
          return;
        }
        if (url.pathname === '/api/prototype-review/codex-models') {
          void runtime
            .then((value) => value.codexModels(request, response, url))
            .then((handled) => {
              if (!handled) writeJson(response, 404, { error: 'Route not found.' });
            })
            .catch(() => writeJson(response, 503, {
              error: 'Codex model settings are temporarily unavailable.'
            }));
          return;
        }
        if (url.pathname.startsWith('/api/codex/sessions')) {
          void runtime
            .then((value) => value.codexSessions(request, response, url))
            .then((handled) => {
              if (!handled) writeJson(response, 404, { error: 'Route not found.' });
            })
            .catch(() => writeJson(response, 503, {
              error: 'The local Codex task is temporarily unavailable.'
            }));
          return;
        }

        next();
      });
    }
  };
}
