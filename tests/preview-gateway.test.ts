import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';

import { createPreviewGatewayRequestHandler } from '../server/preview-gateway';
import {
  previewIdentityHeader,
  previewSignatureHeader
} from '../server/preview-gateway-policy';

interface CapturedRequest {
  authorization?: string;
  cookie?: string;
  forwardedHost?: string;
  identity?: string;
  pathname: string;
  signature?: string;
}

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address.');
  return `http://127.0.0.1:${address.port}`;
}

async function captureServer(captured: CapturedRequest[], label: string) {
  return listen((request, response) => {
    captured.push({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      forwardedHost: request.headers['x-forwarded-host'] as string | undefined,
      identity: request.headers[previewIdentityHeader] as string | undefined,
      pathname: new URL(request.url ?? '/', 'http://test').pathname,
      signature: request.headers[previewSignatureHeader] as string | undefined
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ label }));
  });
}

async function gatewayFixture() {
  const upstreamRequests: CapturedRequest[] = [];
  const brokerRequests: CapturedRequest[] = [];
  const upstreamOrigin = await captureServer(upstreamRequests, 'upstream');
  const brokerOrigin = await captureServer(brokerRequests, 'broker');
  const publicOrigin = 'https://pr-263.projects.os-home.net';
  const handler = createPreviewGatewayRequestHandler({
    PROJECT_SPACE_PREVIEW_BROKER_ORIGIN: brokerOrigin,
    PROJECT_SPACE_PREVIEW_GATEWAY_SECRET: 'preview-only-secret-that-is-long-enough-for-hmac',
    PROJECT_SPACE_PREVIEW_HEAD_SHA: 'a'.repeat(40),
    PROJECT_SPACE_PREVIEW_PR_NUMBER: '263',
    PROJECT_SPACE_PREVIEW_REPOSITORY: 'DotNaos/project-space',
    PROJECT_SPACE_PREVIEW_UPSTREAM_ORIGIN: upstreamOrigin,
    PROJECT_SPACE_PUBLIC_ORIGIN: publicOrigin
  }, {
    authenticate: async (token, options) => token === 'valid-clerk-token' &&
      options.authorizedParties?.[0] === publicOrigin
      ? { login: 'operator', role: 'user', userId: 'user_123' }
      : null
  });
  const gatewayOrigin = await listen(handler);
  const request = (pathname: string, token?: string, headers: Record<string, string> = {}) =>
    fetch(`${gatewayOrigin}${pathname}`, {
    headers: {
      Host: 'pr-263.projects.os-home.net',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    }
  });
  return { brokerRequests, gatewayOrigin, request, upstreamRequests };
}

describe('Preview gateway', () => {
  test('serves static/meta from the PR upstream without forwarding bearer credentials', async () => {
    const fixture = await gatewayFixture();
    expect(await (await fixture.request('/api/app/meta', 'valid-clerk-token')).json())
      .toEqual({ label: 'upstream' });
    expect(fixture.upstreamRequests[0]).toMatchObject({
      authorization: undefined,
      pathname: '/api/app/meta'
    });
  });

  test('adds a short-lived identity assertion only for allowed Preview API calls', async () => {
    const fixture = await gatewayFixture();
    expect(await (await fixture.request('/api/projects', 'valid-clerk-token')).json())
      .toEqual({ label: 'upstream' });
    expect(fixture.upstreamRequests[0]?.authorization).toBeUndefined();
    expect(fixture.upstreamRequests[0]?.identity).toBeTruthy();
    expect(fixture.upstreamRequests[0]?.signature).toBeTruthy();
  });

  test('brokers GitHub and auth session calls with the Clerk token but no Preview assertion', async () => {
    const fixture = await gatewayFixture();
    expect(await (await fixture.request(
      '/api/github/catalog',
      'valid-clerk-token',
      { Cookie: '__session=must-not-leave-the-gateway' }
    )).json())
      .toEqual({ label: 'broker' });
    expect(fixture.brokerRequests[0]).toMatchObject({
      authorization: 'Bearer valid-clerk-token',
      cookie: undefined,
      identity: undefined,
      pathname: '/api/github/catalog',
      signature: undefined
    });
  });

  test('returns decoded broker responses without stale compression headers', async () => {
    const upstreamOrigin = await captureServer([], 'upstream');
    const brokerOrigin = await listen((_request, response) => {
      response.setHeader('Content-Encoding', 'gzip');
      response.setHeader('Content-Type', 'application/json');
      response.end(gzipSync(JSON.stringify({ repositories: ['DotNaos/project-space'] })));
    });
    const publicOrigin = 'https://pr-263.projects.os-home.net';
    const gatewayOrigin = await listen(createPreviewGatewayRequestHandler({
      PROJECT_SPACE_PREVIEW_BROKER_ORIGIN: brokerOrigin,
      PROJECT_SPACE_PREVIEW_GATEWAY_SECRET: 'preview-only-secret-that-is-long-enough-for-hmac',
      PROJECT_SPACE_PREVIEW_HEAD_SHA: 'a'.repeat(40),
      PROJECT_SPACE_PREVIEW_PR_NUMBER: '263',
      PROJECT_SPACE_PREVIEW_REPOSITORY: 'DotNaos/project-space',
      PROJECT_SPACE_PREVIEW_UPSTREAM_ORIGIN: upstreamOrigin,
      PROJECT_SPACE_PUBLIC_ORIGIN: publicOrigin
    }, {
      authenticate: async () => ({ login: 'operator', role: 'user', userId: 'user_123' })
    }));

    const response = await fetch(`${gatewayOrigin}/api/github/catalog`, {
      headers: {
        Authorization: 'Bearer valid-clerk-token',
        Host: 'pr-263.projects.os-home.net'
      }
    });

    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.json()).toEqual({ repositories: ['DotNaos/project-space'] });
  });

  test('never lets an absolute request target or client forwarding header choose the broker destination', async () => {
    const fixture = await gatewayFixture();
    const gateway = new URL(fixture.gatewayOrigin);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(gateway.port), gateway.hostname, () => {
        socket.write(
          'GET https://attacker.example/api/github/catalog HTTP/1.1\r\n' +
          'Host: pr-263.projects.os-home.net\r\n' +
          'Authorization: Bearer valid-clerk-token\r\n' +
          'X-Forwarded-Host: attacker.example\r\n' +
          'Connection: close\r\n\r\n'
        );
      });
      let raw = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        raw += chunk;
      });
      socket.once('end', () => resolve(raw));
      socket.once('error', reject);
    });
    expect(response).toStartWith('HTTP/1.1 421');
    expect(fixture.brokerRequests).toHaveLength(0);
    expect(fixture.upstreamRequests).toHaveLength(0);

    await fixture.request('/api/github/catalog', 'valid-clerk-token');
    expect(fixture.brokerRequests[0]?.forwardedHost).toBeUndefined();
  });

  test('fails closed for missing auth and infrastructure-control paths', async () => {
    const fixture = await gatewayFixture();
    expect((await fixture.request('/api/projects')).status).toBe(401);
    expect((await fixture.request('/api/platform/deploy-project', 'valid-clerk-token')).status)
      .toBe(403);
    expect((await fixture.request('/api/github/issues', 'valid-clerk-token')).status).toBe(403);
    expect((await fixture.request('/api/github/branches', 'valid-clerk-token')).status).toBe(403);
    expect(fixture.upstreamRequests).toHaveLength(0);
    expect(fixture.brokerRequests).toHaveLength(0);
  });
});
