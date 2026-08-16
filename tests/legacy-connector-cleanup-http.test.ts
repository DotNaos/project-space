import { createServer, request as sendHttpRequest, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  createLegacyConnectorCleanupHttpApi,
  legacyConnectorCleanupListPath,
  legacyConnectorCleanupRemovalPath,
  type LegacyConnectorCleanupActor
} from '../server/legacy-connector-cleanup/http';

const servers: Server[] = [];
const fingerprint = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('legacy Connector cleanup HTTP boundary', () => {
  test('owns the exact owner-scoped routes with private responses', async () => {
    const fixture = await start();

    const listed = await fetch(`${fixture.origin}${legacyConnectorCleanupListPath}`);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('private, no-store');
    expect(await listed.json()).toEqual({ records: [], schemaVersion: 1 });
    expect(fixture.calls).toEqual([['list', 'owner-one']]);

    const removed = await fetch(`${fixture.origin}${legacyConnectorCleanupRemovalPath}`, {
      body: JSON.stringify({ records: [{ connectorId: 'connector-one', fingerprint }] }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cleanup-one' },
      method: 'POST'
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ requestId: 'cleanup-one', results: [] });
    expect(fixture.calls[1]).toEqual(['remove', 'owner-one', {
      actorId: 'owner-one',
      records: [{ connectorId: 'connector-one', fingerprint }],
      requestId: 'cleanup-one'
    }]);
  });

  test('requires one exact method, route, query-free request, and strict JSON body', async () => {
    const fixture = await start();
    expect((await fetch(`${fixture.origin}${legacyConnectorCleanupListPath}?all=1`)).status).toBe(400);
    expect(await requestWithBody(
      `${fixture.origin}${legacyConnectorCleanupListPath}`, 'GET', '{}'
    )).toBe(400);
    expect((await fetch(`${fixture.origin}${legacyConnectorCleanupListPath}`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${fixture.origin}${legacyConnectorCleanupRemovalPath}`, { method: 'GET' })).status).toBe(405);
    expect((await fetch(`${fixture.origin}${legacyConnectorCleanupRemovalPath}?all=1`, {
      body: JSON.stringify({ records: [{ connectorId: 'connector-one', fingerprint }] }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cleanup-two' },
      method: 'POST'
    })).status).toBe(400);
    expect((await fetch(`${fixture.origin}${legacyConnectorCleanupRemovalPath}`, {
      body: JSON.stringify({ records: [{ connectorId: 'connector-one', fingerprint }], unexpected: true }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cleanup-three' },
      method: 'POST'
    })).status).toBe(400);
    expect((await fetch(`${fixture.origin}${legacyConnectorCleanupRemovalPath}`, {
      body: JSON.stringify({ records: [{ connectorId: 'connector-one', fingerprint }] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })).status).toBe(400);
    expect((await fetch(`${fixture.origin}${legacyConnectorCleanupRemovalPath}`, {
      body: JSON.stringify({ records: [{ connectorId: 'connector-one', fingerprint: fingerprint.toUpperCase() }] }),
      headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': 'cleanup-four' },
      method: 'POST'
    })).status).toBe(400);
    expect(fixture.calls).toEqual([]);
  });

  test('forbids machine identities and sanitizes authentication, conflicts, and failures', async () => {
    const machine = await start({ actorId: 'machine-one', kind: 'machine', ownerUserId: 'owner-one' });
    const machineResponse = await fetch(`${machine.origin}${legacyConnectorCleanupListPath}`);
    expect(machineResponse.status).toBe(403);
    expect(await machineResponse.json()).toEqual({
      error: { code: 'human_session_required', message: 'A human session is required.' }
    });
    expect(machine.calls).toEqual([]);

    const denied = await start(undefined, { error: { statusCode: 401 } });
    const deniedResponse = await fetch(`${denied.origin}${legacyConnectorCleanupListPath}`);
    expect(deniedResponse.status).toBe(401);
    expect(await deniedResponse.json()).toEqual({
      error: { code: 'authentication_required', message: 'Authentication is required.' }
    });

    const unavailable = await start(undefined, { error: new Error('database password must not leak') });
    const unavailableResponse = await fetch(`${unavailable.origin}${legacyConnectorCleanupListPath}`);
    expect(unavailableResponse.status).toBe(503);
    expect(JSON.stringify(await unavailableResponse.json())).not.toContain('password');

    const conflict = await start(undefined, { error: { code: 'conflict' }, failRemoval: true });
    const conflictResponse = await fetch(`${conflict.origin}${legacyConnectorCleanupRemovalPath}`, {
      body: JSON.stringify({ records: [{ connectorId: 'connector-one', fingerprint }] }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cleanup-conflict' },
      method: 'POST'
    });
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toEqual({
      error: { code: 'removal_conflict', message: 'The legacy Connector cleanup conflicts with current state.' }
    });
  });
});

async function start(
  actor: LegacyConnectorCleanupActor = {
    actorId: 'owner-one', kind: 'human', ownerUserId: 'owner-one'
  },
  options: { error?: unknown; failRemoval?: boolean } = {}
) {
  const calls: unknown[] = [];
  const handler = createLegacyConnectorCleanupHttpApi({
    async list(ownerUserId) {
      if (options.error && !options.failRemoval) throw options.error;
      calls.push(['list', ownerUserId]);
      return { records: [], schemaVersion: 1 };
    },
    async remove(ownerUserId, request) {
      if (options.error && options.failRemoval) throw options.error;
      calls.push(['remove', ownerUserId, request]);
      return { requestId: request.requestId, results: [] };
    }
  }, async () => {
    if (options.error && !options.failRemoval) throw options.error;
    return actor;
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no address.');
  return { calls, origin: `http://127.0.0.1:${address.port}` };
}

function requestWithBody(url: string, method: string, body: string) {
  return new Promise<number>((resolve, reject) => {
    const request = sendHttpRequest(url, {
      headers: { 'Content-Length': String(Buffer.byteLength(body)) },
      method
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });
}
