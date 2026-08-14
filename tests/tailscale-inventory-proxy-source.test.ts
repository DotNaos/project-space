import { describe, expect, test } from 'bun:test';

import {
  createProxyTailscaleInventorySource,
  tailscaleStatusProxyResponseLimitBytes,
  tailscaleStatusProxyTimeoutMs,
  tailscaleStatusProxyUrl,
  type TailscaleStatusProxyFetch
} from '../server/tailscale-inventory/proxy-source';

const observedAt = new Date('2026-08-14T10:00:00Z');

describe('proxy Tailscale inventory source', () => {
  test('uses only the fixed local endpoint with a bounded credential-free GET', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const result = await source(async (url, init) => {
      calls.push([url, init]);
      return json(status());
    }).observe();

    expect(result).toMatchObject({ available: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(tailscaleStatusProxyUrl);
    expect(calls[0]?.[1]).toMatchObject({
      credentials: 'omit', method: 'GET', redirect: 'error'
    });
    expect(calls[0]?.[1].body).toBeUndefined();
    expect(calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(tailscaleStatusProxyTimeoutMs).toBe(3_000);
  });

  test('returns Self and a synthetic-key Peer map through the existing decoder', async () => {
    const result = await source(async () => json(status({
      Peer: {
        'public-key-does-not-become-an-identity': device({
          ID: 'node-peer', TailscaleIPs: ['100.101.0.2']
        })
      }
    }))).observe();

    expect(result).toEqual({
      available: true,
      snapshot: {
        backendState: 'running',
        source: 'tailscale_status_json',
        freshness: {
          observedAt: '2026-08-14T10:00:00.000Z',
          freshUntil: '2026-08-14T10:01:00.000Z',
          state: 'fresh'
        },
        devices: [
          expect.objectContaining({ id: 'node-self', addresses: ['100.64.0.1'] }),
          expect.objectContaining({ id: 'node-peer', addresses: ['100.101.0.2'] })
        ],
        deviceErrors: []
      }
    });
  });

  test.each([
    ['non-200', async () => new Response('token=raw-secret', { status: 503 }), 'proxy_unavailable'],
    ['redirect response', async () => new Response('', { status: 302 }), 'proxy_unavailable'],
    ['aborted request', async () => { throw Object.assign(new Error('token=raw-secret'), { name: 'AbortError' }); }, 'proxy_timed_out'],
    ['aborted response stream', async () => new Response(new ReadableStream({
      pull(controller) {
        controller.error(Object.assign(new Error('token=raw-secret'), { name: 'AbortError' }));
      }
    })), 'proxy_timed_out'],
    ['malformed JSON', async () => new Response('{token=raw-secret'), 'invalid_status'],
    ['invalid root state', async () => json(status({ BackendState: 'Stopped' })), 'invalid_status'],
    ['oversized response', async () => new Response('x'.repeat(tailscaleStatusProxyResponseLimitBytes + 1)), 'proxy_response_too_large']
  ] as const)('returns a sanitized unavailable %s result', async (_case, fetch, code) => {
    const result = await source(fetch).observe();
    expect(result).toEqual({ available: false, error: { code, source: 'proxy' } });
    expect(JSON.stringify(result)).not.toContain('raw-secret');
  });

  test('rejects an actual redirect because fetch is called with redirect error mode', async () => {
    let redirect: RequestRedirect | undefined;
    const result = await source(async (_url, init) => {
      redirect = init.redirect;
      throw new TypeError('redirect blocked; token=raw-secret');
    }).observe();
    expect(redirect).toBe('error');
    expect(result).toEqual({
      available: false, error: { code: 'proxy_unavailable', source: 'proxy' }
    });
  });
});

function source(fetch: TailscaleStatusProxyFetch) {
  return createProxyTailscaleInventorySource({ fetch, now: () => observedAt });
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' }, status: 200
  });
}

function status(overrides: Record<string, unknown> = {}) {
  return { BackendState: 'Running', Peer: {}, Self: device(), ...overrides };
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    ID: 'node-self', HostName: 'os-pc', LastSeen: '2026-08-14T09:59:00Z',
    Online: true, OS: 'linux', Tags: ['tag:developer'], TailscaleIPs: ['100.64.0.1'],
    ...overrides
  };
}
