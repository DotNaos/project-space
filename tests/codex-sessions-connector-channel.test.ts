import { existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  CODEX_SESSIONS_CONNECTOR_CAPABILITY,
  createCodexSessionsWireRequest
} from '../server/codex-sessions-connector-contract';
import {
  isConnectorHubMessage,
  isConnectorMachineMessage,
  type ConnectorHubMessage
} from '../server/connector-command-protocol';
import {
  registerConnectorSession,
  removeConnectorSession
} from '../server/connector-command-session-registry';
import {
  bindingForCodexSessionsRequest
} from '../server/codex-sessions/connector-channel';
import { CodexSessionsConnectorDispatcher } from '../server/codex-sessions/connector-dispatch';
import {
  CodexConnectorRemoteError,
  CodexConnectorOutcomeUnknownError,
  failCodexSessionCommandsForMachine,
  handleCodexSessionsConnectorMessage,
  requestConnectorCodexSessions,
  streamConnectorCodexSessions
} from '../server/codex-sessions/connector-hub';
import type { CodexSessionEventListener } from '../server/codex-sessions/contracts';
import type { CodexSessionManager } from '../server/codex-sessions/manager';
import { defaultCodexAppServerBinary } from '../server/codex-sessions/stdio-transport';
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';

const keys = generateKeyPairSync('ed25519');
const machineId = 'codex-channel-machine';
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';
const now = 1_720_000_000_000;

function fakeSocket(capabilities = [CODEX_SESSIONS_CONNECTOR_CAPABILITY]) {
  const sent: unknown[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) {
      sent.push(JSON.parse(value));
    }
  } as unknown as WebSocket;
  registerConnectorSession(machineId, socket, 'test-token', capabilities);
  return { sent, socket };
}

describe('Codex sessions connector channel', () => {
  test('accepts only typed commands and results bound to the exact request', async () => {
    const { sent, socket } = fakeSocket();
    try {
      const pending = requestConnectorCodexSessions('list', {
        includeArchived: true,
        machineId
      }, {
        now,
        operationId: 'operation-list-one',
        signingKey: keys.privateKey,
        userId: 'user-owner'
      });
      const command = sent[0] as {
        id: string;
        payload: ReturnType<typeof createCodexSessionsWireRequest>;
        type: string;
      };
      expect(command.type).toBe('codex.sessions.command');
      expect(command.payload.grant.generation).toBeGreaterThan(0);
      expect(isConnectorMachineMessage(command)).toBe(true);
      const binding = bindingForCodexSessionsRequest(command.payload);
      const result = {
        id: command.id,
        payload: {
          binding,
          result: {
            operation: 'list' as const,
            result: {
              checkedAt: new Date(now).toISOString(),
              machine: { id: machineId, name: 'Test machine', online: true },
              sessions: []
            }
          }
        },
        type: 'codex.sessions.result' as const
      };
      expect(isConnectorHubMessage(result)).toBe(true);

      const tampered = structuredClone(result);
      tampered.payload.binding.userId = 'different-user';
      expect(handleCodexSessionsConnectorMessage(machineId, tampered)).toBe(true);
      handleCodexSessionsConnectorMessage(machineId, result);
      expect((await pending).operation).toBe('list');

      const arbitrary = structuredClone(command) as unknown as { payload: Record<string, unknown> };
      arbitrary.payload.method = 'shell/execute';
      expect(isConnectorMachineMessage(arbitrary)).toBe(false);
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('streams bound events and cleans up on abort and disconnect', async () => {
    const { sent, socket } = fakeSocket();
    const events: unknown[] = [];
    try {
      const controller = new AbortController();
      const stream = streamConnectorCodexSessions(
        { machineId, threadId },
        (event) => events.push(event),
        {
          generation: 9,
          now,
          operationId: 'operation-stream-one',
          signal: controller.signal,
          signingKey: keys.privateKey,
          userId: 'user-owner'
        }
      );
      const command = sent[0] as {
        id: string;
        payload: ReturnType<typeof createCodexSessionsWireRequest>;
      };
      const binding = bindingForCodexSessionsRequest(command.payload);
      handleCodexSessionsConnectorMessage(machineId, {
        id: command.id,
        payload: {
          binding,
          event: {
            event: { eventId: 'event-one', status: 'idle', type: 'session-status' },
            operation: 'stream'
          }
        },
        type: 'codex.sessions.event'
      });
      expect(events).toEqual([{ eventId: 'event-one', status: 'idle', type: 'session-status' }]);
      controller.abort();
      await stream;
      expect(sent).toContainEqual({ id: command.id, type: 'connector.command.cancel' });

      const reconnect = streamConnectorCodexSessions(
        { machineId, threadId },
        () => {},
        {
          generation: 10,
          now,
          operationId: 'operation-stream-two',
          signingKey: keys.privateKey,
          userId: 'user-owner'
        }
      );
      failCodexSessionCommandsForMachine(machineId);
      await expect(reconnect).rejects.toBeInstanceOf(CodexConnectorOutcomeUnknownError);
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('requires the advertised codex.sessions.v1 capability', async () => {
    const { socket } = fakeSocket([]);
    try {
      await expect(requestConnectorCodexSessions('list', { machineId }, {
        generation: 1,
        signingKey: keys.privateKey,
        userId: 'user-owner'
      })).rejects.toThrow('does not provide Codex sessions');
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('returns bounded execution errors without confusing them with disconnects', async () => {
    const { sent, socket } = fakeSocket();
    try {
      const pending = requestConnectorCodexSessions('read', { machineId, threadId }, {
        generation: 15,
        operationId: 'operation-missing-read',
        signingKey: keys.privateKey,
        userId: 'user-owner'
      });
      const command = sent[0] as {
        id: string;
        payload: ReturnType<typeof createCodexSessionsWireRequest>;
      };
      handleCodexSessionsConnectorMessage(machineId, {
        id: command.id,
        payload: {
          binding: bindingForCodexSessionsRequest(command.payload),
          error: { code: 'rejected' }
        },
        type: 'codex.sessions.error'
      });
      await expect(pending).rejects.toEqual(expect.objectContaining({
        code: 'rejected',
        name: 'CodexConnectorRemoteError'
      } satisfies Partial<CodexConnectorRemoteError>));
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });
});

class DispatchManager {
  listener?: CodexSessionEventListener;

  subscribe(listener: CodexSessionEventListener) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
      return true;
    };
  }

  async listThreads() {
    return { data: [], nextCursor: null };
  }

  async listLoadedThreads() {
    return { data: [] };
  }

  async readThread() {
    throw new Error('missing thread');
  }
}

describe('Codex sessions connector dispatch', () => {
  test('emits bound results and closes authorization failures', async () => {
    const manager = new DispatchManager();
    const dispatcher = new CodexSessionsConnectorDispatcher({
      expectedMachineId: machineId,
      manager: manager as unknown as CodexSessionManager,
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(3);
    const request = createCodexSessionsWireRequest({
      generation: 3,
      operation: 'list',
      operationId: 'operation-dispatch-one',
      payload: { machineId },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-dispatch-one', now: Date.now() });
    const messages: ConnectorHubMessage[] = [];
    let rejected = false;
    dispatcher.dispatch('command-one', request, (message) => messages.push(message), () => {
      rejected = true;
    });
    await Bun.sleep(0);
    expect(rejected).toBe(false);
    expect(messages[0]).toMatchObject({
      id: 'command-one',
      payload: { binding: { machineId, operation: 'list', userId: 'user-owner' } },
      type: 'codex.sessions.result'
    });

    const read = createCodexSessionsWireRequest({
      generation: 3,
      operation: 'read',
      operationId: 'operation-dispatch-read',
      payload: { machineId, threadId },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-dispatch-read', now: Date.now() });
    dispatcher.dispatch('command-read', read, (message) => messages.push(message), () => {
      rejected = true;
    });
    await Bun.sleep(0);
    expect(rejected).toBe(false);
    expect(messages.at(-1)).toMatchObject({
      id: 'command-read',
      payload: { error: { code: 'rejected' } },
      type: 'codex.sessions.error'
    });

    const tampered = structuredClone(request);
    tampered.payload.machineId = 'different-machine';
    dispatcher.dispatch('command-two', tampered, () => {}, () => {
      rejected = true;
    });
    await Bun.sleep(10);
    expect(rejected).toBe(true);
    dispatcher.close();
  });

  test('rejects a grant from an earlier authenticated connector generation', async () => {
    const dispatcher = new CodexSessionsConnectorDispatcher({
      expectedMachineId: machineId,
      manager: new DispatchManager() as unknown as CodexSessionManager,
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(12);
    const stale = createCodexSessionsWireRequest({
      generation: 11,
      operation: 'list',
      operationId: 'operation-stale-generation',
      payload: { machineId },
      userId: 'user-owner'
    }, keys.privateKey);
    let rejected = false;
    dispatcher.dispatch('command-stale', stale, () => {}, () => { rejected = true; });
    await Bun.sleep(10);
    expect(rejected).toBe(true);
    dispatcher.close();
  });
});

describe('Codex sessions connector capability', () => {
  test('advertises the capability only when the bundled App Server exists', async () => {
    const backend = createLocalProjectSpaceBackend({ connectorMachineId: machineId });
    const registry = await backend.getConnectorProjectRegistry();
    expect(registry.connector.capabilities?.includes(CODEX_SESSIONS_CONNECTOR_CAPABILITY))
      .toBe(existsSync(defaultCodexAppServerBinary));
  });
});
