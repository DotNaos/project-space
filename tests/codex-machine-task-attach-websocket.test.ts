import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import { CodexAttachLeaseStore } from '../server/codex-machine-tasks/attach-lease-store';
import { createCodexAttachUpgradeHandler } from '../server/codex-machine-tasks/attach-websocket';

const threadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const lease = {
  callerMachineId: 'caller-one',
  connectorId: 'connector-remote',
  generation: 7,
  operationId: 'attach-operation-one',
  threadId,
  userId: 'user-owner'
};

const cleanup: Array<() => Promise<void>> = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Codex attach WebSocket', () => {
  test('consumes a header-only lease and relays the exact thread', async () => {
    const store = new CodexAttachLeaseStore();
    const sent: string[] = [];
    let remoteMessage: ((message: string) => void) | undefined;
    const handler = createCodexAttachUpgradeHandler(store, async (input, options) => {
      expect(input).toEqual({
        machineId: lease.connectorId,
        operationId: lease.operationId,
        threadId
      });
      expect(options.generation).toBe(lease.generation);
      expect(options.userId).toBe(lease.userId);
      remoteMessage = options.onMessage;
      return {
        close() {},
        send(message: string) { sent.push(message); }
      };
    });
    const origin = await serve(handler);
    const issued = store.issue(lease);
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${issued.endpointPath}`, {
      headers: { Authorization: `Bearer ${issued.token}` }
    });
    clients.push(socket);
    await once(socket, 'open');
    socket.send('{"id":1,"method":"initialize"}');
    for (let attempt = 0; sent.length === 0 && attempt < 20; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(sent).toEqual(['{"id":1,"method":"initialize"}']);

    const received = once(socket, 'message');
    remoteMessage?.('{"id":1,"result":{}}');
    expect((await received)[0].toString()).toBe('{"id":1,"result":{}}');
    socket.terminate();
  });

  test('rejects query credentials, wrong threads, and token replay before upgrade', async () => {
    const store = new CodexAttachLeaseStore();
    const handler = createCodexAttachUpgradeHandler(store, async () => ({
      close() {},
      send() {}
    }));
    const origin = await serve(handler);
    const base = origin.replace('http:', 'ws:');

    const query = store.issue(lease);
    expect(await rejectedStatus(handler, `${query.endpointPath}?token=${query.token}`, query.token))
      .toBe(401);

    const wrongThread = store.issue(lease);
    const otherThread = '019f6d33-6aad-7302-a45e-bb7a33fc399d';
    expect(await rejectedStatus(
      handler,
      `/api/codex/tasks/${otherThread}/attach/socket`,
      wrongThread.token
    )).toBe(401);

    const oneTime = store.issue(lease);
    const accepted = new WebSocket(`${base}${oneTime.endpointPath}`, {
      headers: { Authorization: `Bearer ${oneTime.token}` }
    });
    clients.push(accepted);
    await once(accepted, 'open');
    expect(await rejectedStatus(handler, oneTime.endpointPath, oneTime.token)).toBe(401);
    accepted.terminate();
  });
});

async function serve(handler: ReturnType<typeof createCodexAttachUpgradeHandler>) {
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on('upgrade', (request, socket, head) => {
    if (!handler.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not listen.');
  cleanup.push(async () => {
    handler.close();
    server.close();
    server.closeAllConnections();
    server.unref();
  });
  return `http://127.0.0.1:${address.port}`;
}

async function rejectedStatus(
  handler: ReturnType<typeof createCodexAttachUpgradeHandler>,
  path: string,
  token: string
) {
  const socket = new PassThrough();
  let response = '';
  socket.on('data', (chunk) => { response += chunk.toString('ascii'); });
  const request = {
    headers: { authorization: `Bearer ${token}` },
    rawHeaders: ['Authorization', `Bearer ${token}`],
    url: path
  } as IncomingMessage;
  expect(handler.handleUpgrade(request, socket, Buffer.alloc(0))).toBe(true);
  await once(socket, 'finish');
  return Number(response.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
}
