import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';

import { readAuthTokenFromRequest, readProjectSpaceAuthSession } from './local-auth-store';
import {
  createPrototypeAccessCookie,
  createPreviewIdentityHeaders,
  isGitHubApiPath,
  isBlockedPreviewPath,
  isTrustedGitHubBrokerRequest,
  parsePreviewGatewayBinding,
  readPrototypeAccessCookie,
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

function parseOptionalOrigin(name: string, value: string | undefined) {
  return value?.trim() ? parseOrigin(name, value.trim()) : undefined;
}

function isPrototypeNamespace(pathname: string) {
  return pathname === '/prototype' || pathname.startsWith('/prototype/');
}

function isTrustedPrototypePath(pathname: string) {
  return (
    pathname === '/prototype/meta.json' ||
    pathname === '/prototype/desktop' ||
    pathname.startsWith('/prototype/desktop/') ||
    pathname === '/prototype/mobile' ||
    pathname.startsWith('/prototype/mobile/')
  );
}

const prototypeAccessPath = '/api/pull-request-previews/prototype-access';
const prototypeReviewQueryKeys = [
  'change',
  'orientation',
  'theme',
  'viewport'
] as const;

function prototypeSurface(pathname: string) {
  if (pathname === '/prototype/desktop' || pathname.startsWith('/prototype/desktop/')) {
    return 'desktop-prototype' as const;
  }
  if (pathname === '/prototype/mobile' || pathname.startsWith('/prototype/mobile/')) {
    return 'mobile-prototype' as const;
  }
  return undefined;
}

function isPrototypeEntryPath(pathname: string) {
  return [
    '/prototype/desktop',
    '/prototype/desktop/',
    '/prototype/mobile',
    '/prototype/mobile/'
  ].includes(pathname);
}

function prototypeAccessScope(url: URL) {
  const changeValues = url.searchParams.getAll('change');
  const surfaceValues = url.searchParams.getAll('surface');
  if (
    [...url.searchParams.keys()].some((key) => key !== 'change' && key !== 'surface') ||
    changeValues.length !== 1 ||
    surfaceValues.length !== 1 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeValues[0] ?? '') ||
    !['desktop-prototype', 'mobile-prototype'].includes(surfaceValues[0] ?? '')
  ) {
    return undefined;
  }
  return {
    changeId: changeValues[0]!,
    surface: surfaceValues[0] as 'desktop-prototype' | 'mobile-prototype'
  };
}

function prototypeReviewUrl(
  binding: ReturnType<typeof parsePreviewGatewayBinding>,
  brokerOrigin: string,
  requestUrl: URL
) {
  const target = new URL('/prototype-review', brokerOrigin);
  target.searchParams.set('repositoryFullName', binding.repositoryFullName);
  target.searchParams.set('pullRequestNumber', String(binding.pullRequestNumber));
  target.searchParams.set('head', binding.headSha);
  const requestedReviewSurface = requestUrl.searchParams.getAll('surface');
  target.searchParams.set(
    'surface',
    requestedReviewSurface.length === 1 && requestedReviewSurface[0] === 'native'
      ? 'native'
      : (
          requestUrl.pathname === '/prototype/mobile' ||
          requestUrl.pathname.startsWith('/prototype/mobile/')
        )
        ? 'native'
        : 'web'
  );
  for (const key of prototypeReviewQueryKeys) {
    const values = requestUrl.searchParams.getAll(key);
    if (values.length === 1 && values[0]) target.searchParams.set(key, values[0]);
  }
  return target.toString();
}

function setPrototypeAccessCors(response: ServerResponse, brokerOrigin: string) {
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', 'authorization');
  response.setHeader('Access-Control-Allow-Methods', 'POST');
  response.setHeader('Access-Control-Allow-Origin', brokerOrigin);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Origin');
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
    method: request.method,
    redirect: 'error'
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
  const prototypeOrigin = parseOptionalOrigin(
    'PROJECT_SPACE_PREVIEW_PROTOTYPE_UPSTREAM_ORIGIN',
    environment.PROJECT_SPACE_PREVIEW_PROTOTYPE_UPSTREAM_ORIGIN
  );
  const brokerOrigin = parseOrigin(
    'PROJECT_SPACE_PREVIEW_BROKER_ORIGIN',
    environment.PROJECT_SPACE_PREVIEW_BROKER_ORIGIN ?? 'https://projects.os-home.net'
  );
  const gatewaySecret = environment.PROJECT_SPACE_PREVIEW_GATEWAY_SECRET ?? '';
  if (gatewaySecret.length < 32) {
    throw new Error('PROJECT_SPACE_PREVIEW_GATEWAY_SECRET must contain at least 32 characters.');
  }
  const prototypeAccessSecret = environment.PROJECT_SPACE_PROTOTYPE_ACCESS_SECRET ?? '';
  if (prototypeAccessSecret.length < 32) {
    throw new Error('PROJECT_SPACE_PROTOTYPE_ACCESS_SECRET must contain at least 32 characters.');
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
      if (requestUrl.pathname === prototypeAccessPath) {
        if (request.headers.origin !== brokerOrigin) {
          response.writeHead(403).end('Trusted Project Space origin required.');
          return;
        }
        setPrototypeAccessCors(response, brokerOrigin);
        if (request.method === 'OPTIONS') {
          response.writeHead(204).end();
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { Allow: 'OPTIONS, POST' }).end();
          return;
        }
        const accessScope = prototypeAccessScope(requestUrl);
        if (!accessScope) {
          response.writeHead(400).end('Invalid prototype access scope.');
          return;
        }
        const session = await authenticate(readAuthTokenFromRequest(request), {
          authorizedParties: [brokerOrigin]
        });
        if (!session) {
          response.writeHead(401).end('Login required.');
          return;
        }
        response.setHeader('Set-Cookie', createPrototypeAccessCookie({
          ...accessScope,
          binding,
          secret: prototypeAccessSecret,
          session
        }));
        response.writeHead(204).end();
        return;
      }
      if (
        requestUrl.pathname === '/prototype-review' ||
        requestUrl.pathname.startsWith('/prototype-review/')
      ) {
        response.writeHead(302, {
          'Cache-Control': 'no-store',
          Location: prototypeReviewUrl(binding, brokerOrigin, requestUrl)
        }).end();
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
      if (isPrototypeNamespace(requestUrl.pathname)) {
        if (!prototypeOrigin || !isTrustedPrototypePath(requestUrl.pathname)) {
          response.writeHead(404).end('Prototype surface unavailable.');
          return;
        }
        const requestedSurface = prototypeSurface(requestUrl.pathname);
        const requestedChanges = requestUrl.searchParams.getAll('change');
        const requestedChange = requestedChanges.length === 1
          ? requestedChanges[0]
          : undefined;
        const validRequestedChange = Boolean(
          requestedChange && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedChange)
        );
        const invalidChangeScope =
          requestedChanges.length > 1 ||
          (requestedChanges.length === 1 && !validRequestedChange) ||
          (Boolean(requestedSurface) &&
            isPrototypeEntryPath(requestUrl.pathname) &&
            !validRequestedChange);
        const access = !invalidChangeScope && readPrototypeAccessCookie({
          binding,
          changeId: requestedSurface ? requestedChange : undefined,
          request,
          secret: prototypeAccessSecret,
          surface: requestedSurface
        });
        if (!access) {
          if (request.method === 'GET' || request.method === 'HEAD') {
            response.writeHead(302, {
              'Cache-Control': 'no-store',
              Location: prototypeReviewUrl(binding, brokerOrigin, requestUrl)
            }).end();
            return;
          }
          response.writeHead(401).end('Login required.');
          return;
        }
        headers.delete('authorization');
        await proxy(request, response, prototypeOrigin, headers, requestUrl);
        return;
      }
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
