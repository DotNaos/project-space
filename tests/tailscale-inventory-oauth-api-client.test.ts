import { describe, expect, test } from 'bun:test';

import {
  createTailscaleOAuthApiClient,
  tailscaleDevicesUrl,
  tailscaleInventoryScope,
  tailscaleOAuthTokenUrl,
  type TailscaleApiFetch
} from '../server/tailscale-inventory/oauth-api-client';

const observedAt = new Date('2026-08-14T10:00:00Z');
const credentials = {
  clientId: 'client-id-test-only',
  clientSecret: 'client-secret-test-only'
};

describe('Tailscale OAuth API inventory client', () => {
  test('uses only fixed OAuth and devices endpoints with a narrow read request', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const client = api(async (url, init) => {
      calls.push([url, init]);
      return url === tailscaleOAuthTokenUrl
        ? json(token())
        : json({ devices: [device()] });
    });

    const result = await client.observe(credentials);

    expect(result).toEqual({
      available: true,
      snapshot: {
        backendState: 'running',
        deviceErrors: [],
        devices: [{
          addresses: ['100.101.0.2', 'fd7a:115c:a1e0::2'], id: 'device-exact-id',
          lastSeenAt: '2026-08-14T09:59:00.000Z', observedName: 'exact-device-name',
          online: true, os: 'linux', tags: ['tag:developer']
        }],
        freshness: {
          freshUntil: '2026-08-14T10:01:00.000Z', observedAt: '2026-08-14T10:00:00.000Z',
          state: 'fresh'
        },
        source: 'tailscale_api_devices'
      }
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe(tailscaleOAuthTokenUrl);
    expect(calls[0]?.[1]).toMatchObject({
      credentials: 'omit', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST', redirect: 'error'
    });
    expect(calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.[1].body?.toString()))).toEqual({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: 'client_credentials',
      scope: tailscaleInventoryScope
    });
    expect(calls[1]).toEqual([tailscaleDevicesUrl, expect.objectContaining({
      credentials: 'omit', headers: { Authorization: 'Bearer access-token-test-only' },
      method: 'GET', redirect: 'error'
    })]);
    expect(calls[1]?.[1].body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(credentials.clientId);
    expect(JSON.stringify(result)).not.toContain(credentials.clientSecret);
  });

  test('decodes the current Devices API connectivity field', async () => {
    const result = await api(async (url) => url === tailscaleOAuthTokenUrl
      ? json(token())
      : json({ devices: [device({ connectedToControl: false })] })
    ).observe(credentials);

    expect(result).toMatchObject({
      available: true,
      snapshot: { devices: [{ id: 'device-exact-id', online: false }] }
    });
  });

  test('retains the legacy online field as a compatibility fallback', async () => {
    const result = await api(async (url) => url === tailscaleOAuthTokenUrl
      ? json(token())
      : json({ devices: [device({ connectedToControl: undefined, online: false })] })
    ).observe(credentials);

    expect(result).toMatchObject({
      available: true,
      snapshot: { devices: [{ id: 'device-exact-id', online: false }] }
    });
  });

  test('keeps malformed and duplicate peers partial while retaining exact valid devices', async () => {
    const result = await api(async (url) => url === tailscaleOAuthTokenUrl
      ? json(token())
      : json({ devices: [
        device(),
        'raw-peer-output-must-not-escape',
        device({ id: 'device-exact-id', addresses: ['100.102.0.2'] }),
        device({ addresses: ['192.0.2.44'], id: 'invalid-network-device' })
      ] })
    ).observe(credentials);

    expect(result).toEqual({
      available: true,
      snapshot: expect.objectContaining({
        deviceErrors: [
          { code: 'invalid_device', source: 'peer' },
          { code: 'duplicate_device_id', source: 'peer' },
          { code: 'invalid_network_address', source: 'peer' }
        ],
        devices: [expect.objectContaining({ id: 'device-exact-id' })]
      })
    });
    expect(JSON.stringify(result)).not.toContain('raw-peer-output');
  });

  test('fails closed for malformed device roots without retaining provider payload', async () => {
    const result = await api(async (url) => url === tailscaleOAuthTokenUrl
      ? json(token())
      : json(['raw-api-payload-must-not-escape'])
    ).observe(credentials);

    expect(result).toEqual({
      available: false, error: { code: 'invalid_api_response', source: 'api' }
    });
    expect(JSON.stringify(result)).not.toContain('raw-api-payload');
  });

  test('fails closed when a nonempty device response has no valid devices', async () => {
    const result = await api(async (url) => url === tailscaleOAuthTokenUrl
      ? json(token())
      : json({ devices: [{ id: 'invalid-device', addresses: ['192.0.2.44'] }] })
    ).observe(credentials);

    expect(result).toEqual({
      available: false, error: { code: 'invalid_api_response', source: 'api' }
    });
    expect(JSON.stringify(result)).not.toContain('invalid-device');
  });

  test.each([
    ['token 401', async () => new Response('client-secret-test-only', { status: 401 }), 'credentials_invalid'],
    ['token 403', async () => new Response('client-secret-test-only', { status: 403 }), 'credentials_invalid'],
    ['token transport failure', async () => { throw new Error('client-secret-test-only'); }, 'api_unavailable']
  ] as const)('sanitizes %s without exposing OAuth credentials', async (_case, fetch, code) => {
    const result = await api(fetch).observe(credentials);

    expect(result).toEqual({ available: false, error: { code, source: 'api' } });
    expect(JSON.stringify(result)).not.toContain(credentials.clientId);
    expect(JSON.stringify(result)).not.toContain(credentials.clientSecret);
  });

  test('maps a revoked credential and insufficient devices scope to distinct sanitized failures', async () => {
    for (const [status, code] of [[401, 'credentials_invalid'], [403, 'scope_insufficient']] as const) {
      let requests = 0;
      const result = await api(async () => {
        requests += 1;
        return requests === 1 ? json(token()) : new Response('raw-api-output', { status });
      }).observe(credentials);
      expect(result).toEqual({ available: false, error: { code, source: 'api' } });
      expect(JSON.stringify(result)).not.toContain('raw-api-output');
    }
  });

  test('rejects a token missing the requested scope before it can fetch devices', async () => {
    let requests = 0;
    const result = await api(async () => {
      requests += 1;
      return json(token({ scope: 'devices:core' }));
    }).observe(credentials);

    expect(result).toEqual({
      available: false, error: { code: 'scope_insufficient', source: 'api' }
    });
    expect(requests).toBe(1);
  });

  test('accepts an omitted response scope while the request and device endpoint still enforce it', async () => {
    let requests = 0;
    const result = await api(async (url, init) => {
      requests += 1;
      if (url === tailscaleOAuthTokenUrl) {
        const response = token();
        delete response.scope;
        expect(new URLSearchParams(init?.body?.toString()).get('scope')).toBe(tailscaleInventoryScope);
        return json(response);
      }
      return json({ devices: [] });
    }).observe(credentials);

    expect(result).toMatchObject({ available: true, snapshot: { devices: [] } });
    expect(requests).toBe(2);

    requests = 0;
    const denied = await api(async (url) => {
      requests += 1;
      if (url === tailscaleOAuthTokenUrl) {
        const response = token();
        delete response.scope;
        return json(response);
      }
      return new Response('', { status: 403 });
    }).observe(credentials);
    expect(denied).toEqual({ available: false, error: { code: 'scope_insufficient', source: 'api' } });
    expect(requests).toBe(2);
  });

  test('continues to ask only for narrow inventory scope when the issued token has wider scopes', async () => {
    let tokenRequest: RequestInit | undefined;
    const result = await api(async (url, init) => {
      if (url === tailscaleOAuthTokenUrl) {
        tokenRequest = init;
        return json(token({ scope: `${tailscaleInventoryScope} devices:core` }));
      }
      return json({ devices: [] });
    }).observe(credentials);

    expect(result).toMatchObject({ available: true, snapshot: { devices: [] } });
    expect(new URLSearchParams(tokenRequest?.body?.toString()).get('scope')).toBe(tailscaleInventoryScope);
  });

  test('bounds token and device responses without carrying their raw contents forward', async () => {
    const tokenTooLarge = await api(async () => new Response('client-secret-test-only', {
      headers: { 'content-length': String(64 * 1024 + 1) }
    })).observe(credentials);
    expect(tokenTooLarge).toEqual({
      available: false, error: { code: 'api_response_too_large', source: 'api' }
    });

    let requests = 0;
    const devicesTooLarge = await api(async () => {
      requests += 1;
      return requests === 1 ? json(token()) : new Response('raw-device-response', {
        headers: { 'content-length': String(4 * 1024 * 1024 + 1) }
      });
    }).observe(credentials);
    expect(devicesTooLarge).toEqual({
      available: false, error: { code: 'api_response_too_large', source: 'api' }
    });
    expect(JSON.stringify({ tokenTooLarge, devicesTooLarge })).not.toContain('raw-device-response');
    expect(JSON.stringify({ tokenTooLarge, devicesTooLarge })).not.toContain(credentials.clientSecret);
  });
});

function api(fetch: TailscaleApiFetch) {
  return createTailscaleOAuthApiClient({ fetch, now: () => observedAt });
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' }, status: 200
  });
}

function token(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-token-test-only', expires_in: 3600, scope: tailscaleInventoryScope,
    token_type: 'Bearer', ...overrides
  };
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    addresses: ['100.101.0.2', 'fd7a:115c:a1e0::2'], id: 'device-exact-id',
    connectedToControl: true, lastSeen: '2026-08-14T09:59:00Z', name: 'exact-device-name', os: 'linux',
    tags: ['tag:developer'], ...overrides
  };
}
