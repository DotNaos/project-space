import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { createMachinePowerHttpApi } from './http';

test('machine power HTTP keeps selectors and idempotency exact', async () => {
  const calls: unknown[] = [];
  const handle = createMachinePowerHttpApi({
    async status(_actor, selector) {
      calls.push(selector);
      return {
        apiVersion: 1,
        machine: { id: 'machine-id', name: 'os-pc' },
        message: 'Physical power is off.',
        provider: { deviceId: 'jetkvm-id', kind: 'jetkvm-mqtt' },
        state: 'offline'
      };
    },
    async request(_actor, input) {
      calls.push(input);
      const accepted = input.operationId.endsWith(':accepted');
      return {
        apiVersion: 1,
        dispatch: {
          attempted: true,
          brokerAcknowledged: accepted
        },
        machine: { id: 'machine-id', name: 'os-pc' },
        message: accepted ? 'Broker acknowledged.' : 'Delivery attempted.',
        operationId: input.operationId,
        provider: { deviceId: 'jetkvm-id', kind: 'jetkvm-mqtt' },
        requestedState: input.requestedState,
        state: accepted ? 'accepted' : 'uncertain'
      };
    }
  }, async () => ({ userId: 'owner' }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handle(request, response, url)) response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/machine-power`;
  try {
    const status = await fetch(`${base}?physicalMachineName=os-pc`);
    assert.equal(status.status, 200);

    const rejected = await fetch(base, {
      body: JSON.stringify({
        operationId: 'machine-power:on:accepted',
        physicalMachineName: 'os-pc',
        requestedState: 'on'
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'different-operation'
      },
      method: 'POST'
    });
    assert.equal(rejected.status, 400);

    const accepted = await fetch(base, {
      body: JSON.stringify({
        operationId: 'machine-power:on:accepted',
        physicalMachineName: 'os-pc',
        requestedState: 'on'
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'machine-power:on:accepted'
      },
      method: 'POST'
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json() as { state: string }).state, 'accepted');
    const uncertain = await fetch(base, {
      body: JSON.stringify({
        operationId: 'machine-power:on:uncertain',
        physicalMachineName: 'os-pc',
        requestedState: 'on'
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'machine-power:on:uncertain'
      },
      method: 'POST'
    });
    assert.equal(uncertain.status, 200);
    assert.equal((await uncertain.json() as { state: string }).state, 'uncertain');
    assert.deepEqual(calls, [
      { physicalMachineId: undefined, physicalMachineName: 'os-pc' },
      {
        operationId: 'machine-power:on:accepted',
        physicalMachineId: undefined,
        physicalMachineName: 'os-pc',
        requestedState: 'on'
      },
      {
        operationId: 'machine-power:on:uncertain',
        physicalMachineId: undefined,
        physicalMachineName: 'os-pc',
        requestedState: 'on'
      }
    ]);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});
