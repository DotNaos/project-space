import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CodexDesktopIpcClient,
  CodexDesktopIpcError
} from '../server/codex-sessions/desktop-ipc-client';

type JsonRecord = Record<string, unknown>;

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

describe('Codex Desktop IPC client', () => {
  test('starts an idle turn through the owning Desktop task', async () => {
    const received: JsonRecord[] = [];
    const { socketPath } = await createIpcServer((socket, message) => {
      received.push(message);
      writeFrame(socket, message.method === 'initialize'
        ? {
            handledByClientId: 'desktop-client',
            method: 'initialize',
            requestId: message.requestId,
            result: { clientId: 'prototype-client' },
            resultType: 'success',
            type: 'response'
          }
        : {
            handledByClientId: 'desktop-client',
            method: message.method,
            requestId: message.requestId,
            result: { result: { turn: { id: 'turn-started' } } },
            resultType: 'success',
            type: 'response'
          });
    });
    const client = new CodexDesktopIpcClient({ socketPath });

    await client.startTurn({
      cwd: '/workspace/project-space',
      effort: 'high',
      model: 'gpt-5.6-sol',
      operationId: 'codex:turn:operation-1',
      prompt: 'Start a verified turn',
      serviceTier: 'fast',
      threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
    });

    expect(received[1]).toMatchObject({
      method: 'thread-follower-start-turn',
      sourceClientId: 'prototype-client',
      version: 1,
      params: {
        conversationId: '019fa483-564c-7b01-9d89-5f8ef37af7d0',
        turnStartParams: {
          attachments: [],
          clientUserMessageId: 'codex:turn:operation-1',
          cwd: '/workspace/project-space',
          effort: 'high',
          input: [{
            text: 'Start a verified turn',
            text_elements: [],
            type: 'text'
          }],
          model: 'gpt-5.6-sol',
          serviceTier: 'fast',
          useAppServerPermissionDefault: true
        }
      }
    });
  });

  test('routes a text steer request through the owning Desktop task', async () => {
    const received: JsonRecord[] = [];
    const { socketPath } = await createIpcServer((socket, message) => {
      received.push(message);
      if (message.method === 'initialize') {
        writeFrame(socket, {
          handledByClientId: 'desktop-client',
          method: 'initialize',
          requestId: message.requestId,
          result: { clientId: 'prototype-client' },
          resultType: 'success',
          type: 'response'
        });
      } else if (message.method === 'thread-follower-steer-turn') {
        writeFrame(socket, {
          handledByClientId: 'desktop-client',
          method: message.method,
          requestId: message.requestId,
          result: { result: { turnId: 'turn-1' } },
          resultType: 'success',
          type: 'response'
        });
      }
    });
    const client = new CodexDesktopIpcClient({ socketPath });

    await client.steerTurn({
      cwd: '/workspace/project-space',
      operationId: 'codex:steer:operation-1',
      prompt: 'Text delivery check',
      threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
    });

    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      method: 'thread-follower-steer-turn',
      sourceClientId: 'prototype-client',
      version: 1,
      params: {
        attachments: [],
        clientUserMessageId: 'codex:steer:operation-1',
        conversationId: '019fa483-564c-7b01-9d89-5f8ef37af7d0',
        input: [{
          text: 'Text delivery check',
          text_elements: [],
          type: 'text'
        }],
        restoreMessage: {
          context: {
            prompt: 'Text delivery check',
            workspaceRoots: ['/workspace/project-space']
          },
          cwd: '/workspace/project-space',
          id: 'codex:steer:operation-1',
          text: 'Text delivery check'
        },
        serviceTier: null
      }
    });
  });

  test('forwards local images as native Desktop turn inputs', async () => {
    const received: JsonRecord[] = [];
    const { socketPath } = await createIpcServer((socket, message) => {
      received.push(message);
      writeFrame(socket, message.method === 'initialize'
        ? {
            handledByClientId: 'desktop-client',
            method: 'initialize',
            requestId: message.requestId,
            result: { clientId: 'prototype-client' },
            resultType: 'success',
            type: 'response'
          }
        : {
            handledByClientId: 'desktop-client',
            method: message.method,
            requestId: message.requestId,
            result: { result: { turn: { id: 'turn-with-image' } } },
            resultType: 'success',
            type: 'response'
          });
    });
    const client = new CodexDesktopIpcClient({ socketPath });

    await client.startTurn({
      cwd: '/workspace/project-space',
      localImagePaths: [
        '/private/tmp/project-space-codex-images/image-1.png',
        '/private/tmp/project-space-codex-images/image-2.jpg'
      ],
      operationId: 'codex:turn:image-operation',
      prompt: 'Inspect these screenshots',
      threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
    });

    expect(received[1]).toMatchObject({
      params: {
        turnStartParams: {
          input: [
            {
              text: 'Inspect these screenshots',
              text_elements: [],
              type: 'text'
            },
            {
              path: '/private/tmp/project-space-codex-images/image-1.png',
              type: 'localImage'
            },
            {
              path: '/private/tmp/project-space-codex-images/image-2.jpg',
              type: 'localImage'
            }
          ]
        }
      }
    });
  });

  test('forwards local images when steering an active Desktop turn', async () => {
    const received: JsonRecord[] = [];
    const { socketPath } = await createIpcServer((socket, message) => {
      received.push(message);
      writeFrame(socket, message.method === 'initialize'
        ? {
            handledByClientId: 'desktop-client',
            method: 'initialize',
            requestId: message.requestId,
            result: { clientId: 'prototype-client' },
            resultType: 'success',
            type: 'response'
          }
        : {
            handledByClientId: 'desktop-client',
            method: message.method,
            requestId: message.requestId,
            result: { result: { turnId: 'turn-with-steer-image' } },
            resultType: 'success',
            type: 'response'
          });
    });
    const client = new CodexDesktopIpcClient({ socketPath });

    await client.steerTurn({
      cwd: '/workspace/project-space',
      localImagePaths: ['/private/tmp/project-space-codex-images/image-3.png'],
      operationId: 'codex:steer:image-operation',
      prompt: 'Use this screenshot too',
      threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
    });

    expect(received[1]).toMatchObject({
      params: {
        input: [
          {
            text: 'Use this screenshot too',
            text_elements: [],
            type: 'text'
          },
          {
            path: '/private/tmp/project-space-codex-images/image-3.png',
            type: 'localImage'
          }
        ]
      }
    });
  });

  test('does not treat an unavailable owner as a successful send', async () => {
    const { socketPath } = await createIpcServer((socket, message) => {
      writeFrame(socket, message.method === 'initialize'
        ? {
            handledByClientId: 'desktop-client',
            method: 'initialize',
            requestId: message.requestId,
            result: { clientId: 'prototype-client' },
            resultType: 'success',
            type: 'response'
          }
        : {
            error: 'no-client-found',
            requestId: message.requestId,
            resultType: 'error',
            type: 'response'
          });
    });
    const client = new CodexDesktopIpcClient({ socketPath });

    await expect(client.steerTurn({
      cwd: '/workspace/project-space',
      operationId: 'codex:steer:operation-2',
      prompt: 'Do not lose this text',
      threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
    })).rejects.toBeInstanceOf(CodexDesktopIpcError);
  });
});

async function createIpcServer(
  onMessage: (socket: Socket, message: JsonRecord) => void
) {
  const root = await mkdtemp(join(tmpdir(), 'codex-desktop-ipc-'));
  roots.push(root);
  const socketPath = join(root, 'ipc.sock');
  const server = createServer((socket) => readFrames(socket, onMessage));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath };
}

function readFrames(
  socket: Socket,
  onMessage: (socket: Socket, message: JsonRecord) => void
) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
      buffer = buffer.subarray(length + 4);
      onMessage(socket, message);
    }
  });
}

function writeFrame(socket: Socket, message: JsonRecord) {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length);
  payload.copy(frame, 4);
  socket.write(frame);
}
