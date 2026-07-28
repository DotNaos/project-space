import type { IncomingMessage, ServerResponse } from 'node:http';

const previewDocsOrigin = 'http://docs:3000';

const previewDocsPathPrefixes = [
  '/docs',
  '/_next',
  '/og/docs',
  '/api/search'
] as const;

const previewDocsExactPaths = new Set([
  '/llms.txt',
  '/llms-full.txt'
]);

const skippedRequestHeaders = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'transfer-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'x-project-space-preview-identity',
  'x-project-space-preview-signature'
]);

const skippedResponseHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'location',
  'set-cookie',
  'transfer-encoding'
]);

export function isPreviewDocsPath(pathname: string) {
  return (
    previewDocsExactPaths.has(pathname) ||
    pathname === '/llms.mdx' ||
    pathname.startsWith('/llms.mdx/') ||
    previewDocsPathPrefixes.some(
      (prefix) =>
        pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  );
}

function forwardingHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || skippedRequestHeaders.has(name.toLowerCase())) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function copyResponseHeaders(source: Headers, response: ServerResponse) {
  source.forEach((value, name) => {
    if (!skippedResponseHeaders.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  });
}

function sameHostLocation(value: string) {
  try {
    const location = new URL(value, previewDocsOrigin);
    if (location.origin !== previewDocsOrigin) return undefined;
    return `${location.pathname}${location.search}${location.hash}`;
  } catch {
    return undefined;
  }
}

export interface PreviewDocsProxyDependencies {
  fetch?: typeof globalThis.fetch;
}

export function createPreviewDocsProxy(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PreviewDocsProxyDependencies = {}
) {
  const enabled = environment.PROJECT_SPACE_PREVIEW_MODE === '1';
  const fetchRequest = dependencies.fetch ?? globalThis.fetch;

  return async function proxyPreviewDocs(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (!enabled || !isPreviewDocsPath(url.pathname)) {
      return false;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Docs Preview paths are read-only.');
      return true;
    }

    try {
      const target = new URL(
        `${url.pathname}${url.search}`,
        previewDocsOrigin
      );
      const result = await fetchRequest(target, {
        headers: forwardingHeaders(request),
        method: request.method,
        redirect: 'manual'
      });

      response.statusCode = result.status;
      copyResponseHeaders(result.headers, response);
      response.setHeader(
        'x-project-space-preview-docs-source',
        'exact-pr-source'
      );
      const location = result.headers.get('location');
      if (location) {
        const rewritten = sameHostLocation(location);
        if (!rewritten) {
          response.writeHead(502);
          response.end('Docs Preview returned an invalid redirect.');
          return true;
        }
        response.setHeader('location', rewritten);
      }

      if (!result.body || request.method === 'HEAD') {
        response.end();
        return true;
      }

      for await (const chunk of result.body as unknown as AsyncIterable<
        Uint8Array
      >) {
        response.write(Buffer.from(chunk));
      }
      response.end();
      return true;
    } catch {
      response.writeHead(502);
      response.end('The exact-source Docs Preview is unavailable.');
      return true;
    }
  };
}
