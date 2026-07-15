import { createServer } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { createConnectorRuntimeHttpHandler } from '../server/connector-runtime-http';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) =>
    server.close(() => resolve())
  )));
});

async function start(overrides: Partial<ProjectSpaceBackend>) {
  const backend = new Proxy(overrides as ProjectSpaceBackend, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return async () => { throw new Error(`Unexpected call: ${String(property)}`); };
    }
  });
  const handler = createConnectorRuntimeHttpHandler(backend);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!(await handler(request, response, url))) {
      response.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

describe('connector runtime HTTP API', () => {
  test('returns no-store runtime status for the stable URL machine id', async () => {
    const origin = await start({
      async getMachineRuntime(machineId) {
        return { capabilities: [], machineId, online: false, update: { state: 'offline' } };
      }
    });
    const response = await fetch(`${origin}/api/machines/machine-1/runtime`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ machineId: 'machine-1' });
  });

  test('submits only a named operation and approved release id', async () => {
    const calls: unknown[] = [];
    const origin = await start({
      async startMachineRuntimeOperation(machineId, request) {
        calls.push({ machineId, request });
        return {
          operation: {
            createdAt: '', id: 'operation-1', machineId, operation: request.operation,
            requestedByUserId: 'owner', state: 'queued', updatedAt: ''
          },
          status: { capabilities: [], machineId, online: true, update: { state: 'updating' } }
        };
      }
    });
    const response = await fetch(`${origin}/api/machines/machine-1/runtime/operations`, {
      body: JSON.stringify({ operation: 'update', releaseId: 'v0.5.0' }),
      headers: { 'content-type': 'application/json' }, method: 'POST'
    });
    expect(response.status).toBe(202);
    expect(calls).toEqual([{
      machineId: 'machine-1',
      request: { operation: 'update', releaseId: 'v0.5.0' }
    }]);
  });

  test('rejects arbitrary fields and mutable release aliases before backend dispatch', async () => {
    let dispatches = 0;
    const origin = await start({
      async startMachineRuntimeOperation() {
        dispatches += 1;
        throw new Error('not reached');
      }
    });
    for (const body of [
      { command: 'rm -rf ~', operation: 'update' },
      { operation: 'update', releaseId: 'latest' },
      { operation: 'restart', releaseId: 'v0.5.0' }
    ]) {
      const response = await fetch(`${origin}/api/machines/machine-1/runtime/operations`, {
        body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST'
      });
      expect(response.status).toBe(400);
    }
    expect(dispatches).toBe(0);
  });

  test('stops a selected runtime only with an exactly empty body', async () => {
    const calls: string[] = [];
    const origin = await start({
      async stopMachineRuntime(machineId) {
        calls.push(machineId);
        return { operationId: 'operation-stop', status: 'accepted' };
      }
    });
    const accepted = await fetch(`${origin}/api/machines/machine-1/runtime/stop`, {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ operationId: 'operation-stop', status: 'accepted' });

    const rejected = await fetch(`${origin}/api/machines/machine-1/runtime/stop`, {
      body: JSON.stringify({ pid: 42 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    });
    expect(rejected.status).toBe(400);
    expect(calls).toEqual(['machine-1']);
  });
});
