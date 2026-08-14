import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'bun:test';
import { createTailscaleInventoryHttpApi } from '../server/tailscale-inventory/http';
import { TailscaleClassificationRevisionConflict } from '../server/tailscale-inventory/service';
import { CodexMachineTasksAuthError } from '../server/codex-machine-tasks/auth-context';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
async function start(
  actor = { actorId: 'owner', kind: 'human' as const, ownerUserId: 'owner' },
  options: { authError?: CodexMachineTasksAuthError; conflict?: boolean } = {}
) {
  const calls: unknown[] = []; const api = createTailscaleInventoryHttpApi({
    async list(owner, refresh) { calls.push(['list', owner, refresh]); return { devices: [], provider: { refreshState: 'available' }, schemaVersion: 1 }; },
    async setClassification(requestActor, id, request) {
      calls.push(['classify', requestActor, id, request]);
      if (options.conflict) {
        throw new TailscaleClassificationRevisionConflict({
          classification: 'environment', id, revision: request.expectedRevision + 1
        });
      }
      return { id, ...request, revision: request.expectedRevision + 1 };
    },
    async getConnection(owner) {
      calls.push(['get-connection', owner]);
      return { connectionState: 'not_connected', requiredScope: 'devices:core:read', source: 'not_connected' };
    },
    async connect(requestActor, request) {
      calls.push(['connect', requestActor, request]);
      return { connectionId: 'safe-connection-id', connectionState: 'connected', requiredScope: 'devices:core:read', source: 'tailscale_oauth_api' };
    },
    async revoke(requestActor) {
      calls.push(['revoke', requestActor]);
      return { connectionState: 'not_connected', requiredScope: 'devices:core:read', source: 'not_connected' };
    }
  }, async () => {
    if (options.authError) throw options.authError;
    return actor;
  });
  const server = createServer(async (request, response) => { const url = new URL(request.url ?? '/', 'http://127.0.0.1'); if (!await api(request, response, url)) response.writeHead(404).end(); }); servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('address'); return { calls, origin: `http://127.0.0.1:${address.port}` };
}
describe('Tailscale inventory HTTP boundary', () => {
  test('allows only exact refresh query and private no-store GET', async () => { const { calls, origin } = await start(); const response = await fetch(`${origin}/api/compute/tailscale/devices?refresh=1`); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(calls).toEqual([['list', 'owner', true]]); expect((await fetch(`${origin}/api/compute/tailscale/devices?refresh=true`)).status).toBe(400); });
  test('enforces strict JSON human classification and never refreshes source', async () => { const { calls, origin } = await start(); const url = `${origin}/api/compute/tailscale/devices/device-a/classification`; expect((await fetch(url, { body: JSON.stringify({ classification: 'environment', expectedRevision: 0 }), headers: { 'Content-Type': 'application/json' }, method: 'POST' })).status).toBe(200); expect(calls[0]).toEqual(['classify', expect.objectContaining({ kind: 'human' }), 'device-a', { classification: 'environment', expectedRevision: 0 }]); expect((await fetch(url, { body: JSON.stringify({ classification: 'ignored', expectedRevision: 0, extra: true }), headers: { 'Content-Type': 'application/json' }, method: 'POST' })).status).toBe(400); });
  test('manages only the authenticated owner connection and never echoes credentials', async () => {
    const { calls, origin } = await start();
    const route = `${origin}/api/compute/tailscale/connection`;
    expect((await fetch(route)).status).toBe(200);
    const credentials = { clientId: 'client-id-private', clientSecret: 'client-secret-private' };
    const connected = await fetch(route, {
      body: JSON.stringify(credentials), headers: { 'Content-Type': 'application/json' }, method: 'POST'
    });
    expect(connected.status).toBe(200);
    expect(JSON.stringify(await connected.json())).not.toMatch(/client-id-private|client-secret-private/);
    expect((await fetch(route, { method: 'DELETE' })).status).toBe(200);
    expect(calls).toEqual([
      ['get-connection', 'owner'],
      ['connect', expect.objectContaining({ kind: 'human', ownerUserId: 'owner' }), credentials],
      ['revoke', expect.objectContaining({ kind: 'human', ownerUserId: 'owner' })]
    ]);
    expect((await fetch(`${route}?owner=other`)).status).toBe(400);
    expect((await fetch(route, {
      body: JSON.stringify({ ...credentials, ownerUserId: 'other' }),
      headers: { 'Content-Type': 'application/json' }, method: 'POST'
    })).status).toBe(400);
  });
  test('decodes one encoded stable device id without accepting an encoded path', async () => {
    const { calls, origin } = await start();
    const init = { body: JSON.stringify({ classification: 'ignored', expectedRevision: 0 }), headers: { 'Content-Type': 'application/json' }, method: 'POST' };
    expect((await fetch(`${origin}/api/compute/tailscale/devices/device%3Aa/classification`, init)).status).toBe(200);
    expect(calls[0]).toEqual(['classify', expect.anything(), 'device:a', expect.anything()]);
    expect((await fetch(`${origin}/api/compute/tailscale/devices/device%2Fa/classification`, init)).status).toBe(400);
  });
  test('forbids machine callers and maps revision conflicts', async () => {
    const machine = await start({ actorId: 'machine', kind: 'machine', ownerUserId: 'owner' });
    const path = '/api/compute/tailscale/devices/device-a/classification';
    const init = { body: JSON.stringify({ classification: 'ignored', expectedRevision: 0 }), headers: { 'Content-Type': 'application/json' }, method: 'POST' };
    expect((await fetch(`${machine.origin}/api/compute/tailscale/devices`)).status).toBe(403);
    expect((await fetch(`${machine.origin}${path}`, init)).status).toBe(403);
    const conflict = await start(undefined, { conflict: true });
    const response = await fetch(`${conflict.origin}${path}`, init);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'revision_conflict' }) });
  });
  test('sanitizes authentication failures and strictly owns its route prefix', async () => {
    const denied = await start(undefined, { authError: new CodexMachineTasksAuthError(401) });
    const response = await fetch(`${denied.origin}/api/compute/tailscale/devices`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'authentication_failed', message: 'Authentication failed.' }
    });

    const unmatched = await fetch(`${denied.origin}/api/not-tailscale`);
    expect(unmatched.status).toBe(404);
    expect(unmatched.headers.get('cache-control')).toBeNull();
    const unknownTailscaleRoute = await fetch(`${denied.origin}/api/compute/tailscale/devices/other`);
    expect(unknownTailscaleRoute.status).toBe(404);
    expect(unknownTailscaleRoute.headers.get('cache-control')).toBe('private, no-store');
  });
});
