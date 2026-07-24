import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';

import { readAuthTokenFromRequest, readProjectSpaceAuthSession } from './local-auth-store';
import {
  createPreviewIdentityHeaders,
  isGitHubApiPath,
  isBlockedPreviewPath,
  isTrustedGitHubBrokerRequest,
  parsePreviewGatewayBinding,
  previewIdentityHeader,
  previewSignatureHeader
} from './preview-gateway-policy';

const maximumRequestBytes = 25 * 1024 * 1024;

function parseOrigin(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required.`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') {
    throw new Error(`${name} must be a plain HTTP or HTTPS origin.`);
  }
  return url.origin;
}

async function readBody(request: IncomingMessage) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) throw new Error('Preview request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function forwardingHeaders(headers: IncomingHttpHeaders) {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (
      !value ||
      [
        'accept-encoding',
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
        'x-real-ip'
      ].includes(name)
    ) continue;
    forwarded.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  forwarded.delete(previewIdentityHeader);
  forwarded.delete(previewSignatureHeader);
  return forwarded;
}

function copyResponseHeaders(source: Headers, response: ServerResponse) {
  source.forEach((value, name) => {
    if (
      !['connection', 'content-encoding', 'content-length', 'transfer-encoding']
        .includes(name.toLowerCase())
    ) {
      response.setHeader(name, value);
    }
  });
}

async function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  targetOrigin: string,
  headers: Headers,
  requestUrl: URL
) {
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const body = await readBody(request);
  const result = await fetch(target, {
    body,
    headers,
    method: request.method
  });
  response.statusCode = result.status;
  copyResponseHeaders(result.headers, response);
  if (!result.body || request.method === 'HEAD') {
    response.end();
    return;
  }
  for await (const chunk of result.body as unknown as AsyncIterable<Uint8Array>) {
    response.write(Buffer.from(chunk));
  }
  response.end();
}

interface PreviewGatewayDependencies {
  authenticate?: typeof readProjectSpaceAuthSession;
}

export function createPreviewGatewayRequestHandler(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PreviewGatewayDependencies = {}
) {
  const binding = parsePreviewGatewayBinding(environment);
  const upstreamOrigin = parseOrigin(
    'PROJECT_SPACE_PREVIEW_UPSTREAM_ORIGIN',
    environment.PROJECT_SPACE_PREVIEW_UPSTREAM_ORIGIN
  );
  const brokerOrigin = parseOrigin(
    'PROJECT_SPACE_PREVIEW_BROKER_ORIGIN',
    environment.PROJECT_SPACE_PREVIEW_BROKER_ORIGIN ?? 'https://projects.os-home.net'
  );
  const gatewaySecret = environment.PROJECT_SPACE_PREVIEW_GATEWAY_SECRET ?? '';
  if (gatewaySecret.length < 32) {
    throw new Error('PROJECT_SPACE_PREVIEW_GATEWAY_SECRET must contain at least 32 characters.');
  }
  const authenticate = dependencies.authenticate ?? readProjectSpaceAuthSession;

  return async function handlePreviewGatewayRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    try {
      const requestUrl = new URL(request.url ?? '/', binding.origin);
      if (
        request.headers.host !== new URL(binding.origin).host ||
        requestUrl.origin !== binding.origin
      ) {
        response.writeHead(421).end('Preview host mismatch.');
        return;
      }
      if (isBlockedPreviewPath(requestUrl.pathname)) {
        response.writeHead(403).end('This operation is disabled in PR previews.');
        return;
      }
      if (
        isGitHubApiPath(requestUrl.pathname) &&
        !isTrustedGitHubBrokerRequest(request.method, requestUrl.pathname)
      ) {
        response.writeHead(403).end('This GitHub operation is disabled in PR previews.');
        return;
      }

      const headers = forwardingHeaders(request.headers);
      const isPublicUpstreamPath =
        requestUrl.pathname === '/api/health' || requestUrl.pathname === '/api/app/meta';
      if (isPublicUpstreamPath || !requestUrl.pathname.startsWith('/api/')) {
        headers.delete('authorization');
        await proxy(request, response, upstreamOrigin, headers, requestUrl);
        return;
      }

      const token = readAuthTokenFromRequest(request);
      const session = await authenticate(token, {
        authorizedParties: [binding.origin]
      });
      if (!session) {
        response.writeHead(401).end('Login required.');
        return;
      }

      if (isTrustedGitHubBrokerRequest(request.method, requestUrl.pathname)) {
        await proxy(request, response, brokerOrigin, headers, requestUrl);
        return;
      }

      headers.delete('authorization');
      const identityHeaders = createPreviewIdentityHeaders({
        binding,
        secret: gatewaySecret,
        session
      });
      headers.set(previewIdentityHeader, identityHeaders[previewIdentityHeader]);
      headers.set(previewSignatureHeader, identityHeaders[previewSignatureHeader]);
      await proxy(request, response, upstreamOrigin, headers, requestUrl);
    } catch (error) {
      response.writeHead(502).end(error instanceof Error ? error.message : 'Preview gateway failed.');
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.PROJECT_SPACE_HOST ?? '127.0.0.1';
  const server = createServer(createPreviewGatewayRequestHandler());
  server.listen(port, host, () => {
    console.log(`Project Space Preview gateway listening on http://${host}:${port}`);
  });
}
