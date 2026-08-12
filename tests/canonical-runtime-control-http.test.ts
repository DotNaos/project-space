import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { CodexMachineTasksAuthError } from '../server/codex-machine-tasks/auth-context';
import {
  canonicalRuntimeControlPath,
  createCanonicalRuntimeControlHttpApi
} from '../server/canonical-runtime-control/http';

const servers: Server[] = [];
const environmentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generation = '22222222-2222-4222-8222-222222222222';

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('canonical Runtime control HTTP boundary', () => {
  test('binds authenticated actor, idempotency, and the closed inspection request', async () => {
    const calls: unknown[] = [];
    const origin = await start(createCanonicalRuntimeControlHttpApi({
      async execute(actor, request) {
        calls.push({ actor, request });
        return result(request.operationId);
      }
    }, async () => ({ actorId: 'machine-one', actorKind: 'agent', ownerUserId: 'owner-one' })));
    const input = request('operation-one');
    const response = await fetch(`${origin}${canonicalRuntimeControlPath}`, {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.operationId },
      method: 'POST'
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(result(input.operationId));
    expect(calls).toEqual([{
      actor: { actorId: 'machine-one', actorKind: 'agent', ownerUserId: 'owner-one' },
      request: input
    }]);
  });

  test('rejects query input, mismatched idempotency, oversized bodies, and bad auth', async () => {
    let calls = 0;
    const origin = await start(createCanonicalRuntimeControlHttpApi({
      async execute() { calls += 1; return result('operation-one'); }
    }, async () => ({ actorId: 'owner', actorKind: 'human', ownerUserId: 'owner' })));
    const query = await fetch(`${origin}${canonicalRuntimeControlPath}?path=/tmp`, {
      body: JSON.stringify(request('operation-one')),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operation-one' },
      method: 'POST'
    });
    expect(query.status).toBe(405);
    const mismatch = await fetch(`${origin}${canonicalRuntimeControlPath}`, {
      body: JSON.stringify(request('operation-one')),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'different' },
      method: 'POST'
    });
    expect(mismatch.status).toBe(400);
    const oversized = await fetch(`${origin}${canonicalRuntimeControlPath}`, {
      body: JSON.stringify({ ...request('operation-two'), padding: 'x'.repeat(20_000) }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operation-two' },
      method: 'POST'
    });
    expect(oversized.status).toBe(400);
    expect(calls).toBe(0);

    const denied = await start(createCanonicalRuntimeControlHttpApi(
      { async execute() { throw new Error('must not run'); } },
      async () => { throw new CodexMachineTasksAuthError(401); }
    ));
    const unauthorized = await fetch(`${denied}${canonicalRuntimeControlPath}`, {
      body: JSON.stringify(request('operation-three')),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operation-three' },
      method: 'POST'
    });
    expect(unauthorized.status).toBe(401);
  });
});

function request(operationId: string) {
  return {
    apiVersion: 1 as const,
    environmentId,
    expectedGeneration: generation,
    expectedTargetIdentityRevision: '7:environment:canonical',
    operation: 'git.status' as const,
    operationId,
    workspaceId
  };
}

function result(operationId: string) {
  return {
    apiVersion: 1,
    compatibilityAlias: false,
    environmentId,
    generation,
    operation: 'git.status',
    operationId,
    output: { clean: true, conflicted: 0, staged: 0, truncated: false, unstaged: 0, untracked: 0 },
    replayed: false,
    state: 'completed',
    targetIdentityRevision: '7:environment:canonical',
    workspaceId
  };
}

async function start(handler: ReturnType<typeof createCanonicalRuntimeControlHttpApi>) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no address.');
  return `http://127.0.0.1:${address.port}`;
}
