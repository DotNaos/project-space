import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { WebSocket } from 'ws';

import { MemoryRuntimeSessionStore } from '../server/workspace-runtime-session/memory-store';
import { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import { createWorkspaceRuntimeSessionUpgradeHandler } from '../server/workspace-runtime-session/upgrade-handler';
import { workspaceRuntimeCapabilities } from '../src/shared/workspace-runtime-session-api';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const commit = 'a'.repeat(40);
const manifestDigest = 'b'.repeat(64);

describe('Workspace Runtime WebSocket gateway', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  test('authenticates before upgrade and carries registration, heartbeat, and graceful stop', async () => {
    const store = new MemoryRuntimeSessionStore();
    const issued = await store.issue({
      branch: 'issue-625', capabilities: [...workspaceRuntimeCapabilities], commit,
      environmentId, generation, manifestDigest, ownerUserId: 'owner',
      operationId: 'start:websocket', runtimeVersion: '0.4.66', workspaceId
    });
    const runtime = await startGateway(store);
    cleanups.push(runtime.close);
    const socket = new WebSocket(`${runtime.origin}/api/workspace-runtimes/socket`, {
      headers: { Authorization: `Bearer ${issued.credential.token}` }
    });
    socket.on('error', () => {});
    await opened(socket);
    socket.send(JSON.stringify({
      branch: 'issue-625', codexControllerState: 'ready', commit, environmentId, generation, manifestDigest,
      resumeAfterCodexCommandSequence: 0, resumeAfterCodexEventSequence: 0,
      resumeAfterSequence: 0, runtimeVersion: '0.4.66', schemaVersion: 1,
      type: 'runtime.register', workspaceId
    }));
    expect(await message(socket)).toMatchObject({ acceptedSequence: 0, type: 'runtime.registered' });
    socket.send(JSON.stringify({
      eventId: 'running', observedAt: new Date().toISOString(), schemaVersion: 1,
      sequence: 1, state: 'running', type: 'runtime.lifecycle'
    }));
    expect(await message(socket)).toMatchObject({ acceptedSequence: 1, replayed: false });
    socket.send(JSON.stringify({
      eventId: 'stopping', observedAt: new Date().toISOString(), schemaVersion: 1,
      sequence: 2, state: 'stopping', type: 'runtime.lifecycle'
    }));
    await message(socket);
    socket.send(JSON.stringify({
      eventId: 'stopped', observedAt: new Date().toISOString(), schemaVersion: 1,
      sequence: 3, state: 'stopped', type: 'runtime.lifecycle'
    }));
    expect(await message(socket)).toMatchObject({ acceptedSequence: 3 });
    expect((await closed(socket)).code).toBe(1000);
    expect((await store.list('owner'))[0]).toMatchObject({
      connectionState: 'stopped', lastSequence: 3, lifecycleState: 'stopped'
    });
  });

  test('rejects missing credentials, query credentials, binary frames, and unknown fields', async () => {
    const store = new MemoryRuntimeSessionStore();
    const issued = await store.issue({
      branch: 'issue-625', capabilities: [...workspaceRuntimeCapabilities], commit,
      environmentId, generation, manifestDigest, ownerUserId: 'owner',
      operationId: 'start:websocket-invalid', runtimeVersion: '0.4.66', workspaceId
    });
    const runtime = await startGateway(store);
    cleanups.push(runtime.close);
    for (const url of [
      `${runtime.origin}/api/workspace-runtimes/socket`,
      `${runtime.origin}/api/workspace-runtimes/socket?token=${issued.credential.token}`
    ]) {
      await expect(new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.once('open', () => reject(new Error('unauthorized socket opened')));
        socket.on('error', () => resolve());
      })).resolves.toBeUndefined();
    }
    const socket = new WebSocket(`${runtime.origin}/api/workspace-runtimes/socket`, {
      headers: { Authorization: `Bearer ${issued.credential.token}` }
    });
    socket.on('error', () => {});
    await opened(socket);
    socket.send(Buffer.from([1, 2, 3]));
    expect((await closed(socket)).code).toBe(1003);
  });
});

async function startGateway(store: MemoryRuntimeSessionStore) {
  const service = new WorkspaceRuntimeSessionService(store);
  const gateway = createWorkspaceRuntimeSessionUpgradeHandler(service);
  const server = createServer((_request, response) => response.writeHead(404).end());
  const connections = new Set<Socket>();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    if (!gateway.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return {
    close: async () => {
      await gateway.close();
      server.close();
      for (const socket of connections) socket.destroy();
    },
    origin: `ws://127.0.0.1:${address.port}`
  };
}

function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function message(socket: WebSocket) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket) {
  return new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}
