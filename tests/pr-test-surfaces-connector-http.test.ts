import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createPullRequestDevServerConnectorRoutes } from '../server/pr-test-surfaces/connector-http';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function request(
  options: Parameters<typeof createPullRequestDevServerConnectorRoutes>[0],
  payload: Record<string, unknown>,
  token = 'connector-token'
) {
  const route = createPullRequestDevServerConnectorRoutes(options);
  const server = createServer(async (incoming, response) => {
    await route(incoming, response, new URL(incoming.url ?? '/', 'http://127.0.0.1'));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return fetch(
    `http://127.0.0.1:${port}/api/pull-request-previews/dev-server/register`,
    {
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      method: 'POST'
    }
  );
}

describe('PR Dev Server connector HTTP route', () => {
  test('binds the lease actor to the authenticated connector and owner', async () => {
    let actor: unknown;
    const response = await request({
      register: async (received) => {
        actor = received;
        return {
          heartbeatIntervalSeconds: 15,
          lease: { expiresAt: '2026-07-27T12:00:45.000Z', generation: 1, id: 'lease-1' },
          leaseDurationSeconds: 45
        } as never;
      },
      resolveIdentity: async (token, machineId) => token === 'connector-token'
        ? { machineId, userId: 'user-1' }
        : null
    }, {
      connectorId: 'connector-1',
      machineId: '11111111-1111-4111-8111-111111111111'
    });

    expect(response.status).toBe(200);
    expect(actor).toEqual({
      connectorId: 'connector-1',
      machineId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1'
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test('rejects unclaimed connector credentials before registering anything', async () => {
    let called = false;
    const response = await request({
      register: async () => {
        called = true;
        throw new Error('must not run');
      },
      resolveIdentity: async () => null
    }, {
      connectorId: 'connector-1',
      machineId: '11111111-1111-4111-8111-111111111111'
    }, 'wrong-token');

    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });
});
