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
const previewVerificationSecret = 'preview-verification-secret-that-is-long-enough';

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

async function gatewayFixture(options: {
  offline?: boolean;
  prototypeConfigured?: boolean;
  prototypeRedirect?: boolean;
} = {}) {
  const upstreamRequests: CapturedRequest[] = [];
  const brokerRequests: CapturedRequest[] = [];
  const prototypeRequests: CapturedRequest[] = [];
  const upstreamOrigin = await captureServer(upstreamRequests, 'upstream');
  const brokerOrigin = await captureServer(brokerRequests, 'broker');
  const prototypeOrigin = options.prototypeRedirect
    ? await listen((request, response) => {
        prototypeRequests.push({
          pathname: new URL(request.url ?? '/', 'http://test').pathname
        });
        response.writeHead(302, { Location: `${upstreamOrigin}/api/machines` }).end();
      })
    : await captureServer(prototypeRequests, 'prototype');
  const publicOrigin = 'https://pr-263.projects.os-home.net';
  const handler = createPreviewGatewayRequestHandler({
    PROJECT_SPACE_PREVIEW_BROKER_ORIGIN: brokerOrigin,
    PROJECT_SPACE_PREVIEW_OFFLINE: options.offline ? '1' : '0',
    PROJECT_SPACE_PREVIEW_VERIFIED: options.offline ? '0' : '1',
    PROJECT_SPACE_PREVIEW_GATEWAY_SECRET: 'preview-only-secret-that-is-long-enough-for-hmac',
    PROJECT_SPACE_PREVIEW_HEAD_SHA: 'a'.repeat(40),
    PROJECT_SPACE_PREVIEW_PR_NUMBER: '263',
    PROJECT_SPACE_PREVIEW_VERIFICATION_SECRET: previewVerificationSecret,
    ...(options.prototypeConfigured === false
      ? {}
      : { PROJECT_SPACE_PREVIEW_PROTOTYPE_UPSTREAM_ORIGIN: prototypeOrigin }),
    PROJECT_SPACE_PREVIEW_REPOSITORY: 'DotNaos/project-space',
    PROJECT_SPACE_PREVIEW_UPSTREAM_ORIGIN: upstreamOrigin,
    PROJECT_SPACE_PROTOTYPE_ACCESS_SECRET: 'prototype-access-secret-that-is-gateway-only',
    PROJECT_SPACE_PUBLIC_ORIGIN: publicOrigin
  }, {
    authenticate: async (token, options) => token === 'valid-clerk-token' &&
      [publicOrigin, brokerOrigin].includes(options.authorizedParties?.[0] ?? '')
      ? { login: 'operator', role: 'user', userId: 'user_123' }
      : null
  });
  const gatewayOrigin = await listen(handler);
  const request = (
    pathname: string,
    token?: string,
    headers: Record<string, string> = {},
    method = 'GET'
  ) =>
    fetch(`${gatewayOrigin}${pathname}`, {
    headers: {
      Host: 'pr-263.projects.os-home.net',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    method,
    redirect: 'manual'
  });
  return {
    brokerOrigin,
    brokerRequests,
    gatewayOrigin,
    prototypeRequests,
    request,
    upstreamRequests
  };
}

describe('Preview gateway', () => {
  test('redirects offline browser requests to the trusted hub without touching PR code', async () => {
    const fixture = await gatewayFixture({ offline: true });
    const response = await fixture.request('/deep/path?filter=ready');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `${fixture.brokerOrigin}/?pr=263&return=%2Fdeep%2Fpath%3Ffilter%3Dready`
    );
    expect(fixture.upstreamRequests).toHaveLength(0);
    expect(fixture.prototypeRequests).toHaveLength(0);
    expect(fixture.brokerRequests).toHaveLength(0);
  });

  test('lets the trusted runner verify an offline Preview before activation', async () => {
    const fixture = await gatewayFixture({ offline: true });
    const verificationHeaders = {
      'x-project-space-preview-verification': previewVerificationSecret
    };

    expect((await fixture.request('/api/auth/session', undefined, verificationHeaders)).status)
      .toBe(401);
    expect((await fixture.request('/', undefined, verificationHeaders)).status).toBe(200);
    expect(fixture.upstreamRequests).toHaveLength(1);
    expect(fixture.upstreamRequests[0]?.pathname).toBe('/');
    expect(fixture.brokerRequests).toHaveLength(0);
  });

  test('serves static/meta from the PR upstream without forwarding bearer credentials', async () => {
    const fixture = await gatewayFixture();
    expect(await (await fixture.request('/api/app/meta', 'valid-clerk-token')).json())
      .toEqual({ label: 'upstream' });
    expect(fixture.upstreamRequests[0]).toMatchObject({
      authorization: undefined,
      pathname: '/api/app/meta'
    });
  });

  test('serves the exact changelog only to the trusted review hub', async () => {
    const fixture = await gatewayFixture();
    const response = await fixture.request(
      '/api/app/changelog',
      'must-not-reach-upstream',
      { Origin: fixture.brokerOrigin }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(fixture.brokerOrigin);
    expect(fixture.upstreamRequests[0]).toMatchObject({
      authorization: undefined,
      pathname: '/api/app/changelog'
    });

    const preflight = await fixture.request(
      '/api/app/changelog',
      undefined,
      { Origin: fixture.brokerOrigin },
      'OPTIONS'
    );
    expect(preflight.status).toBe(204);
    expect(fixture.upstreamRequests).toHaveLength(1);

    expect((await fixture.request(
      '/api/app/changelog',
      undefined,
      { Origin: 'https://attacker.example' }
    )).status).toBe(403);
    expect(fixture.upstreamRequests).toHaveLength(1);
  });

  test('adds a short-lived identity assertion only for allowed Preview API calls', async () => {
    const fixture = await gatewayFixture();
    expect(await (await fixture.request('/api/projects', 'valid-clerk-token')).json())
      .toEqual({ label: 'upstream' });
    expect(fixture.upstreamRequests[0]?.authorization).toBeUndefined();
    expect(fixture.upstreamRequests[0]?.identity).toBeTruthy();
    expect(fixture.upstreamRequests[0]?.signature).toBeTruthy();
  });

  test('requires a trusted authenticated viewing grant before serving prototype code', async () => {
    const fixture = await gatewayFixture();
    expect((await fixture.request('/prototype/meta.json')).status).toBe(302);
    expect(fixture.prototypeRequests).toHaveLength(0);
    const unauthenticated = await fixture.request(
      '/prototype/desktop/?change=secure-live-context&scenario=ready&viewport=phone',
      'valid-clerk-token'
    );
    expect(unauthenticated.status).toBe(302);
    expect(unauthenticated.headers.get('location')).toBe(
      `http://127.0.0.1:${new URL(fixture.brokerOrigin).port}/prototype-review?` +
      `repositoryFullName=DotNaos%2Fproject-space&pullRequestNumber=263&head=${'a'.repeat(40)}` +
      '&surface=web&change=secure-live-context&viewport=phone'
    );
    expect(fixture.prototypeRequests).toHaveLength(0);

    const grant = await fixture.request(
      '/api/pull-request-previews/prototype-access?' +
        'change=secure-live-context&surface=desktop-prototype',
      'valid-clerk-token',
      { Origin: fixture.brokerOrigin },
      'POST'
    );
    expect(grant.status).toBe(204);
    expect(grant.headers.get('set-cookie')).toContain('Max-Age=30');
    const cookie = grant.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toStartWith('__Host-project-space-prototype-access=');

    const response = await fixture.request(
      '/prototype/desktop/?change=secure-live-context&scenario=ready&viewport=phone',
      'must-not-reach-prototype',
      {
        Cookie: cookie!,
        [previewIdentityHeader]: 'client-supplied-identity',
        [previewSignatureHeader]: 'client-supplied-signature'
      }
    );
    expect(await response.json()).toEqual({ label: 'prototype' });
    expect(fixture.prototypeRequests[0]).toMatchObject({
      authorization: undefined,
      cookie: undefined,
      identity: undefined,
      pathname: '/prototype/desktop/',
      signature: undefined
    });
    expect(fixture.upstreamRequests).toHaveLength(0);
    expect(fixture.brokerRequests).toHaveLength(0);

    expect((await fixture.request('/prototype/meta.json', undefined, { Cookie: cookie! })).status)
      .toBe(200);
    expect((await fixture.request(
      '/prototype/desktop/assets/app.js',
      undefined,
      { Cookie: cookie! }
    )).status).toBe(200);
    expect((await fixture.request(
      '/prototype/desktop/',
      undefined,
      { Cookie: cookie! }
    )).status).toBe(302);
    expect((await fixture.request(
      '/prototype/mobile/?change=secure-live-context',
      undefined,
      { Cookie: cookie! }
    )).status).toBe(302);
    expect((await fixture.request(
      '/prototype/desktop/?change=secure-live-context&change=other-change',
      undefined,
      { Cookie: cookie! }
    )).status).toBe(302);
    expect(fixture.prototypeRequests).toHaveLength(3);
  });

  test('rejects unauthorized prototype grants and never accepts cookies for privileged APIs', async () => {
    const fixture = await gatewayFixture();
    expect((await fixture.request(
      '/api/pull-request-previews/prototype-access?' +
        'change=secure-live-context&surface=desktop-prototype',
      undefined,
      { Origin: fixture.brokerOrigin },
      'POST'
    )).status).toBe(401);
    expect((await fixture.request(
      '/api/pull-request-previews/prototype-access?' +
        'change=secure-live-context&surface=desktop-prototype',
      'valid-clerk-token',
      { Origin: 'https://attacker.example' },
      'POST'
    )).status).toBe(403);
    expect((await fixture.request(
      '/api/machines',
      undefined,
      { Cookie: '__Host-project-space-prototype-access=forged' }
    )).status).toBe(403);
    expect(fixture.upstreamRequests).toHaveLength(0);
    expect(fixture.prototypeRequests).toHaveLength(0);
  });

  test('keeps the trusted review shell on the broker origin', async () => {
    const fixture = await gatewayFixture();
    const response = await fixture.request(
      '/prototype-review?repository=attacker%2Frepository&pr=999&' +
        'head=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&change=secure-live-context&' +
        'surface=native&viewport=phone'
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `${fixture.brokerOrigin}/prototype-review?repositoryFullName=DotNaos%2Fproject-space&` +
      `pullRequestNumber=263&head=${'a'.repeat(40)}&surface=native&` +
      'change=secure-live-context&viewport=phone'
    );
    expect(fixture.upstreamRequests).toHaveLength(0);
  });

  test('never follows a PR-controlled redirect from the prototype upstream', async () => {
    const fixture = await gatewayFixture({ prototypeRedirect: true });
    const grant = await fixture.request(
      '/api/pull-request-previews/prototype-access?' +
        'change=secure-live-context&surface=desktop-prototype',
      'valid-clerk-token',
      { Origin: fixture.brokerOrigin },
      'POST'
    );
    const cookie = grant.headers.get('set-cookie')?.split(';')[0];
    const response = await fixture.request(
      '/prototype/desktop/?change=secure-live-context',
      undefined,
      { Cookie: cookie! }
    );
    expect(response.status).toBe(502);
    expect(fixture.prototypeRequests).toHaveLength(1);
    expect(fixture.upstreamRequests).toHaveLength(0);
  });

  test('keeps prototype routes unavailable until the trusted runner configures the static upstream', async () => {
    const fixture = await gatewayFixture({ prototypeConfigured: false });

    expect((await fixture.request('/prototype/desktop/')).status).toBe(404);
    expect(fixture.prototypeRequests).toHaveLength(0);
    expect(fixture.upstreamRequests).toHaveLength(0);
    expect(fixture.brokerRequests).toHaveLength(0);
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
      PROJECT_SPACE_PREVIEW_VERIFIED: '1',
      PROJECT_SPACE_PREVIEW_GATEWAY_SECRET: 'preview-only-secret-that-is-long-enough-for-hmac',
      PROJECT_SPACE_PREVIEW_HEAD_SHA: 'a'.repeat(40),
      PROJECT_SPACE_PREVIEW_PR_NUMBER: '263',
      PROJECT_SPACE_PREVIEW_REPOSITORY: 'DotNaos/project-space',
      PROJECT_SPACE_PREVIEW_UPSTREAM_ORIGIN: upstreamOrigin,
      PROJECT_SPACE_PROTOTYPE_ACCESS_SECRET: 'prototype-access-secret-that-is-gateway-only',
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
