import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { CodexMachineTasksAuthError } from '../server/codex-machine-tasks/auth-context';
import {
  createMachineReadinessHttpApi,
  type MachineReadinessHttpService
} from '../server/machine-readiness/http';
import { MachineReadinessServiceError } from '../server/machine-readiness/service';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function startApi(
  service: MachineReadinessHttpService,
  resolveActor: Parameters<typeof createMachineReadinessHttpApi>[1] = async () => ({
    userId: 'owner'
  })
) {
  const api = createMachineReadinessHttpApi(service, resolveActor);
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

function stub() {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const service: MachineReadinessHttpService = {
    async diagnose(actor, selector) {
      calls.push({ kind: 'diagnose', value: { actor, selector } });
      return { apiVersion: 1, state: 'ready' };
    },
    async fix(actor, request) {
      calls.push({ kind: 'fix', value: { actor, request } });
      return { apiVersion: 1, state: 'repairing' };
    }
  };
  return { calls, service };
}

describe('machine readiness HTTP boundary', () => {
  test('keeps diagnosis read-only and passes exact selectors', async () => {
    const { calls, service } = stub();
    const origin = await startApi(service);
    const response = await fetch(
      `${origin}/api/machine-readiness?physicalMachineName=os-pc&connectorId=linux-stable`
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      kind: 'diagnose',
      value: {
        actor: { userId: 'owner' },
        selector: {
          connectorId: 'linux-stable',
          physicalMachineId: undefined,
          physicalMachineName: 'os-pc'
        }
      }
    }]);
  });

  test('requires an identical idempotency key and exact bounded plan', async () => {
    const { calls, service } = stub();
    const origin = await startApi(service);
    const body = {
      operationId: 'doctor:operation-one',
      physicalMachineId: 'physical-pc',
      planId: 'a'.repeat(64)
    };
    const missingKey = await fetch(`${origin}/api/machine-readiness`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(missingKey.status).toBe(400);
    expect(calls).toHaveLength(0);

    const accepted = await fetch(`${origin}/api/machine-readiness`, {
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': body.operationId
      },
      method: 'POST'
    });
    expect(accepted.status).toBe(202);
    expect(calls).toEqual([{
      kind: 'fix',
      value: {
        actor: { userId: 'owner' },
        request: {
          connectorId: undefined,
          operationId: body.operationId,
          physicalMachineId: 'physical-pc',
          physicalMachineName: undefined,
          planId: body.planId
        }
      }
    }]);
  });

  test('rejects normalized or repeated selectors instead of guessing', async () => {
    const { calls, service } = stub();
    const origin = await startApi(service);
    for (const query of [
      'physicalMachineName=%20os-pc%20',
      'physicalMachineName=os-pc&physicalMachineName=os-macbook'
    ]) {
      const response = await fetch(`${origin}/api/machine-readiness?${query}`);
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test('reports stale plans and authorization failures without dispatching', async () => {
    const { service } = stub();
    service.fix = async () => {
      throw new MachineReadinessServiceError('stale-plan', 'Plan changed.');
    };
    const origin = await startApi(service);
    const response = await fetch(`${origin}/api/machine-readiness`, {
      body: JSON.stringify({
        operationId: 'doctor:stale',
        physicalMachineName: 'os-pc',
        planId: 'b'.repeat(64)
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'doctor:stale'
      },
      method: 'POST'
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: 'stale_plan', message: 'Plan changed.' }
    });

    const deniedOrigin = await startApi(stub().service, async () => {
      throw new CodexMachineTasksAuthError(401);
    });
    const denied = await fetch(
      `${deniedOrigin}/api/machine-readiness?physicalMachineName=os-pc`
    );
    expect(denied.status).toBe(401);
  });
});
