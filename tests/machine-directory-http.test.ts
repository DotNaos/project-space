import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  createMachineDirectoryHttpApi,
  type MachineDirectoryHttpService
} from '../server/machine-directory/http';
import { createConfiguredMachineDirectoryHandler } from '../server/machine-directory/configured-runtime';
import { MachineDirectoryServiceError } from '../server/machine-directory/service';
import { getCurrentAuthSession } from '../server/local-auth-store';
import type {
  CodexThreadCatalogResult,
  MachineDirectoryResult,
  MachineSshConnectionResult
} from '../src/shared/machine-directory-api';

const servers: Server[] = [];
const checkedAt = '2026-07-28T16:00:00.000Z';
const machineId = '11111111-1111-4111-8111-111111111111';

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function machines(): MachineDirectoryResult {
  return {
    checkedAt,
    failures: [],
    machines: [],
    schemaVersion: 1
  };
}

function threads(): CodexThreadCatalogResult {
  return {
    checkedAt,
    hosts: [],
    partial: false,
    schemaVersion: 1,
    threads: []
  };
}

function ssh(): MachineSshConnectionResult {
  return {
    machine: { id: machineId, name: 'os-pc' },
    schemaVersion: 1,
    target: 'os-pc'
  };
}

async function start(handler: ReturnType<typeof createMachineDirectoryHttpApi>) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address.');
  return `http://127.0.0.1:${address.port}`;
}

function service(calls: unknown[]): MachineDirectoryHttpService {
  return {
    async listCodexThreads(actor, request) {
      calls.push(['threads', actor, request]);
      return threads();
    },
    async listMachines(actor) {
      calls.push(['machines', actor]);
      return machines();
    },
    async resolveSsh(actor, selectedMachineId) {
      calls.push(['ssh', actor, selectedMachineId]);
      return ssh();
    }
  };
}

describe('machine directory CLI HTTP boundary', () => {
  test('serves private machine, thread, and SSH discovery for one actor', async () => {
    const calls: unknown[] = [];
    const origin = await start(createMachineDirectoryHttpApi(
      service(calls),
      async () => ({ callerMachineId: 'caller-mac', userId: 'owner' })
    ));

    const machineResponse = await fetch(`${origin}/api/machines/catalog`);
    const threadResponse = await fetch(
      `${origin}/api/codex/catalog?machineId=${machineId}` +
      '&search=roadmap&state=idle&state=active&includeArchived=true'
    );
    const sshResponse = await fetch(
      `${origin}/api/machines/catalog/${machineId}/ssh`
    );

    expect(await machineResponse.json()).toEqual(machines());
    expect(await threadResponse.json()).toEqual(threads());
    expect(await sshResponse.json()).toEqual(ssh());
    expect([
      machineResponse.headers.get('cache-control'),
      threadResponse.headers.get('cache-control'),
      sshResponse.headers.get('cache-control')
    ]).toEqual(['private, no-store', 'private, no-store', 'private, no-store']);
    expect(calls).toEqual([
      ['machines', { callerMachineId: 'caller-mac', userId: 'owner' }],
      ['threads', { callerMachineId: 'caller-mac', userId: 'owner' }, {
        includeArchived: true,
        machineId,
        search: 'roadmap',
        states: ['active', 'idle']
      }],
      ['ssh', { callerMachineId: 'caller-mac', userId: 'owner' }, machineId]
    ]);
  });

  test('rejects unsupported methods, selectors, and query fields before dispatch', async () => {
    const calls: unknown[] = [];
    const origin = await start(createMachineDirectoryHttpApi(
      service(calls),
      async () => ({ userId: 'owner' })
    ));
    const requests: Array<[string, RequestInit?]> = [
      ['/api/machines/catalog?other=1'],
      ['/api/machines/catalog', { method: 'POST' }],
      ['/api/codex/catalog?machineId=a&machineName=b'],
      ['/api/codex/catalog?includeArchived=maybe'],
      ['/api/codex/catalog?state=not%20safe'],
      ['/api/machines/catalog/not-an-id/ssh']
    ];
    for (const [path, init] of requests) {
      const response = await fetch(origin + path, init);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request' }
      });
    }
    expect(calls).toEqual([]);
  });

  test('returns safe structured discovery errors', async () => {
    const failing = service([]);
    failing.resolveSsh = async () => {
      throw new MachineDirectoryServiceError(
        'ssh_unavailable',
        'SSH is unavailable for this physical machine.'
      );
    };
    const origin = await start(createMachineDirectoryHttpApi(
      failing,
      async () => ({ userId: 'owner' })
    ));

    const response = await fetch(`${origin}/api/machines/catalog/${machineId}/ssh`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'ssh_unavailable',
        message: 'SSH is unavailable for this physical machine.'
      }
    });
  });

  test('binds configured inventory loads to the machine credential account', async () => {
    const observed: string[] = [];
    const handler = createConfiguredMachineDirectoryHandler({
      backend: {
        async getConnectorOverview() {
          observed.push(`backend:${getCurrentAuthSession()?.userId ?? ''}`);
          return {
            machines: [],
            machinesRepo: { exists: false, path: '' },
            tailscale: {
              backendState: 'unknown',
              installed: false,
              ips: [],
              peersOnline: 0,
              serveOrigins: []
            }
          };
        }
      },
      databaseConfigured: () => true,
      async identities(userId) {
        observed.push(`identities:${userId}`);
        return [];
      },
      machineConnection: {
        async resolveMachineCredentialIdentity(token, callerMachineId) {
          return token === 'machine-token' && callerMachineId === 'caller-mac'
            ? { machineId: callerMachineId, userId: 'owner-user' }
            : null;
        }
      },
      async physicalMachines(userId) {
        observed.push(`machines:${userId}`);
        return [];
      }
    });
    const origin = await start(handler);
    const response = await fetch(`${origin}/api/machines/catalog`, {
      headers: {
        Authorization: 'Bearer machine-token',
        'X-Project-Machine-ID': 'caller-mac'
      }
    });

    expect(response.status).toBe(200);
    expect(observed.sort()).toEqual([
      'backend:owner-user',
      'identities:owner-user',
      'machines:owner-user'
    ]);
  });
});
