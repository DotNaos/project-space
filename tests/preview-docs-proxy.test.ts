import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';

import { createPreviewDocsProxy } from '../server/preview-docs-proxy';

const servers: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startProxy(input: {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}) {
  const proxy = createPreviewDocsProxy(
    input.environment ?? { PROJECT_SPACE_PREVIEW_MODE: '1' },
    { fetch: input.fetch }
  );
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!(await proxy(request, response, url))) {
      response.writeHead(404).end('Not proxied.');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test proxy did not expose a port.');
  }
  const running = {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
  servers.push(running);
  return running;
}

describe('Preview Docs proxy', () => {
  test('proxies exact Docs routes and assets without credentials', async () => {
    const requests: Array<{
      authorization: string | null;
      cookie: string | null;
      previewIdentity: string | null;
      previewSignature: string | null;
      url: string;
    }> = [];
    const server = await startProxy({
      fetch: (async (request, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get('authorization'),
          cookie: headers.get('cookie'),
          previewIdentity: headers.get(
            'x-project-space-preview-identity'
          ),
          previewSignature: headers.get(
            'x-project-space-preview-signature'
          ),
          url: String(request)
        });
        return new Response('<h1>Changelog</h1>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          status: 200
        });
      }) as typeof globalThis.fetch
    });

    const response = await fetch(
      `${server.origin}/docs/changelog?pr=298`,
      {
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'x-project-space-preview-identity': 'signed-identity',
          'x-project-space-preview-signature': 'signed-value'
        }
      }
    );

    expect(response.status).toBe(200);
    expect(
      response.headers.get('x-project-space-preview-docs-source')
    ).toBe('exact-pr-source');
    expect(await response.text()).toContain('Changelog');
    expect(requests).toEqual([
      {
        authorization: null,
        cookie: null,
        previewIdentity: null,
        previewSignature: null,
        url: 'http://docs:3000/docs/changelog?pr=298'
      }
    ]);
  });

  test('rewrites internal redirects to the same Preview host', async () => {
    const server = await startProxy({
      fetch: (async () =>
        new Response(null, {
          headers: {
            location: 'http://docs:3000/docs/changelog?pr=298'
          },
          status: 307
        })) as typeof globalThis.fetch
    });

    const response = await fetch(`${server.origin}/docs/changelog`, {
      redirect: 'manual'
    });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      '/docs/changelog?pr=298'
    );
  });

  test('rejects cross-origin redirects and mutations', async () => {
    const server = await startProxy({
      fetch: (async () =>
        new Response(null, {
          headers: { location: 'https://example.com/' },
          status: 307
        })) as typeof globalThis.fetch
    });

    const redirect = await fetch(`${server.origin}/docs/changelog`, {
      redirect: 'manual'
    });
    const mutation = await fetch(`${server.origin}/docs/changelog`, {
      method: 'POST'
    });

    expect(redirect.status).toBe(502);
    expect(redirect.headers.get('location')).toBeNull();
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get('allow')).toBe('GET, HEAD');
  });

  test('does not intercept non-Preview or unrelated paths', async () => {
    const disabled = await startProxy({
      environment: {},
      fetch: (async () => {
        throw new Error('must not fetch');
      }) as typeof globalThis.fetch
    });
    const enabled = await startProxy({
      fetch: (async () => {
        throw new Error('must not fetch');
      }) as typeof globalThis.fetch
    });

    expect((await fetch(`${disabled.origin}/docs/changelog`)).status).toBe(
      404
    );
    expect((await fetch(`${enabled.origin}/projects`)).status).toBe(404);
    expect((await fetch(`${enabled.origin}/api/app/meta`)).status).toBe(
      404
    );
  });

  test('recognizes the Docs search namespace', async () => {
    const server = await startProxy({
      fetch: (async (request) =>
        Response.json({ target: String(request) })) as typeof globalThis.fetch
    });

    const response = await fetch(
      `${server.origin}/api/search?query=changelog`
    );

    expect(await response.json()).toEqual({
      target: 'http://docs:3000/api/search?query=changelog'
    });
  });

  test('matches only the intended llms routes', async () => {
    const proxied: string[] = [];
    const server = await startProxy({
      fetch: (async (request) => {
        proxied.push(String(request));
        return new Response('ok');
      }) as typeof globalThis.fetch
    });

    for (const path of [
      '/llms.txt',
      '/llms-full.txt',
      '/llms.mdx',
      '/llms.mdx/docs/changelog'
    ]) {
      expect((await fetch(`${server.origin}${path}`)).status).toBe(200);
    }
    for (const path of ['/llms', '/llms-private', '/api/search-private']) {
      expect((await fetch(`${server.origin}${path}`)).status).toBe(404);
    }
    expect(proxied).toEqual([
      'http://docs:3000/llms.txt',
      'http://docs:3000/llms-full.txt',
      'http://docs:3000/llms.mdx',
      'http://docs:3000/llms.mdx/docs/changelog'
    ]);
  });
});
