import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { createCodexAuthorizationHttpApi } from '../server/codex-authorization/http';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function startApi(calls: unknown[]) {
  const api = createCodexAuthorizationHttpApi({
    async authorize(actor, request) {
      calls.push({ actor, request });
      return {
        apiVersion: 1,
        message: 'Pending.',
        operationId: request.operationId,
        state: 'pending'
      };
    }
  }, async () => ({ userId: 'owner' }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await api(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address.');
  return `http://127.0.0.1:${address.port}`;
}

describe('Codex authorization HTTP boundary', () => {
  test('requires an exact selector, action, and matching idempotency key', async () => {
    const calls: unknown[] = [];
    const origin = await startApi(calls);
    const body = {
      action: 'start',
      operationId: 'codex:login:operation-one',
      physicalMachineName: 'os-pc'
    };
    const missingKey = await fetch(`${origin}/api/codex/authorization`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(missingKey.status).toBe(400);

    const accepted = await fetch(`${origin}/api/codex/authorization`, {
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': body.operationId
      },
      method: 'POST'
    });
    expect(accepted.status).toBe(200);
    expect(calls).toEqual([{
      actor: { userId: 'owner' },
      request: {
        action: 'start',
        connectorId: undefined,
        operationId: body.operationId,
        physicalMachineId: undefined,
        physicalMachineName: 'os-pc'
      }
    }]);
  });

  test('rejects arbitrary auth methods, extra fields, and mixed selectors', async () => {
    const calls: unknown[] = [];
    const origin = await startApi(calls);
    for (const body of [
      {
        action: 'logout',
        operationId: 'codex:login:operation-one',
        physicalMachineName: 'os-pc'
      },
      {
        action: 'start',
        apiKey: 'must-not-be-accepted',
        operationId: 'codex:login:operation-one',
        physicalMachineName: 'os-pc'
      },
      {
        action: 'start',
        operationId: 'codex:login:operation-one',
        physicalMachineId: 'physical-pc',
        physicalMachineName: 'os-pc'
      }
    ]) {
      const response = await fetch(`${origin}/api/codex/authorization`, {
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'codex:login:operation-one'
        },
        method: 'POST'
      });
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});
