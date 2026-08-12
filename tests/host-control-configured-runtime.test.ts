import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import type { HostControlBinding } from '../server/host-control/contracts';
import { createConfiguredHostControlHandler } from '../server/host-control/configured-runtime';
import { createMachinePowerHostControlProvider } from '../server/host-control/machine-power-provider';
import type { MachinePowerHttpService } from '../server/machine-power/http';

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPostgresUrl = process.env.POSTGRES_URL;

afterEach(() => {
  restore('DATABASE_URL', originalDatabaseUrl);
  restore('POSTGRES_URL', originalPostgresUrl);
});

describe('configured Host control runtime', () => {
  test('claims the production route and fails closed when durable storage is unavailable', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    const handler = createConfiguredHostControlHandler({
      backend: { async getConnectorOverview() { throw new Error('must not load inventory'); } }
    });
    const server = createServer(async (request, response) => {
      const handled = await handler(
        request,
        response,
        new URL(request.url ?? '/', 'http://127.0.0.1')
      );
      if (!handled) response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/compute/hosts/os-pc/status`);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        error: { code: 'host_control_unavailable', message: 'Host control is not configured.' }
      });
      const unrelated = await fetch(`http://127.0.0.1:${address.port}/not-host-control`);
      expect(unrelated.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('bridges only supported real machine-power status and power-on operations', async () => {
    const requests: unknown[] = [];
    const machinePower: MachinePowerHttpService = {
      async request(actor, request) {
        requests.push({ actor, request });
        return {
          operationId: request.operationId,
          physicalMachineId: request.physicalMachineId!,
          provider: { kind: 'jetkvm-mqtt' },
          requestedState: request.requestedState,
          schemaVersion: 1,
          state: 'confirmed-online'
        };
      },
      async status() {
        return {
          evidence: {
            checkedAt: '2026-08-12T10:00:00.000Z',
            fresh: true,
            jetKvmOnline: true,
            physicalPower: true
          },
          message: 'online',
          physicalMachineId: '24000000-0000-4000-8000-000000000001',
          physicalMachineName: 'os-pc',
          provider: { kind: 'jetkvm-mqtt' },
          schemaVersion: 1,
          state: 'online'
        };
      }
    };
    const provider = createMachinePowerHostControlProvider(machinePower);
    const binding = fixtureBinding();
    await expect(provider.status(binding)).resolves.toMatchObject({
      available: true, powerState: 'on', lastVerifiedAt: '2026-08-12T10:00:00.000Z'
    });
    await expect(provider.power(binding, 'on', {
      actor: { callerMachineId: 'machine-one', userId: 'owner-one' }, operationId: 'power-one'
    })).resolves.toBe('completed');
    expect(requests).toEqual([{
      actor: { callerMachineId: 'machine-one', userId: 'owner-one' },
      request: {
        operationId: `host-control:${createHash('sha256').update('power-one').digest('hex')}`,
        physicalMachineId: '24000000-0000-4000-8000-000000000001',
        requestedState: 'on'
      }
    }]);
    await expect(provider.power(binding, 'off', {
      actor: { userId: 'owner-one' }, operationId: 'power-off'
    })).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(provider.screenshot(binding)).rejects.toMatchObject({ code: 'capability_unavailable' });
  });
});

function fixtureBinding(): HostControlBinding {
  return {
    bindingRevision: 'b'.repeat(64),
    capabilities: {
      available: true,
      console: [],
      hostId: '10000000-0000-4000-8000-000000000001',
      power: ['status', 'on'],
      provider: { id: 'jetkvm-one', kind: 'jetkvm' },
      schemaVersion: 1
    },
    machinePower: { physicalMachineId: '24000000-0000-4000-8000-000000000001' },
    ownerUserId: 'owner-one'
  };
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
