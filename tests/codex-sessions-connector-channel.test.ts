import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  CODEX_BROWSER_MAXIMUM_IMAGE_BYTES
} from '../src/shared/codex-sessions-api';
import { CODEX_DAEMON_CONNECTOR_CAPABILITY } from '../src/shared/codex-daemon-api';
import {
  CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY,
  CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY,
  createCodexSessionsWireRequest
} from '../server/codex-sessions-connector-contract';
import {
  isConnectorHubMessage,
  isConnectorMachineMessage,
  type ConnectorHubMessage
} from '../server/connector-command-protocol';
import {
  connectorHasCapability,
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
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';

const keys = generateKeyPairSync('ed25519');
const machineId = 'codex-channel-machine';
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';
const now = 1_720_000_000_000;

function fakeSocket(capabilities = [
  CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY,
  CODEX_SESSIONS_CONNECTOR_CAPABILITY
]) {
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

function inspectionResult(overrides: {
  machineId?: string;
  sessionRevision?: string;
  threadId?: string;
} = {}) {
  const inspectedMachineId = overrides.machineId ?? machineId;
  const inspectedThreadId = overrides.threadId ?? threadId;
  const checkedAt = new Date(now).toISOString();
  const sessionRevision = overrides.sessionRevision ?? 'a'.repeat(64);
  return {
    checkedAt,
    openedReadOnly: true as const,
    session: {
      archived: false,
      cwd: '/projects/project-space',
      id: inspectedThreadId,
      lastActivityAt: checkedAt,
      loadedByProjectSpace: true,
      machineId: inspectedMachineId,
      machineName: 'Test machine',
      status: 'idle' as const,
      title: 'Implement topology command center'
    },
    sessionRevision,
    taskLocation: {
      canonicalCwd: '/projects/project-space',
      checkedAt,
      machineId: inspectedMachineId,
      sessionRevision,
      source: 'connector-realpath' as const,
      threadId: inspectedThreadId,
      worktreeRoot: '/projects/project-space'
    }
  };
}

describe('Codex sessions connector channel', () => {
  test('round-trips a near-limit browser frame inside the 2 MiB connector envelope', () => {
    const request = createCodexSessionsWireRequest({
      generation: 3,
      operation: 'browser',
      operationId: 'operation-browser-envelope',
      payload: { machineId, threadId },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-browser-envelope', now });
    const frame = Buffer.alloc(CODEX_BROWSER_MAXIMUM_IMAGE_BYTES, 0x5a).toString('base64');
    const message = {
      id: 'command-browser-envelope',
      payload: {
        binding: bindingForCodexSessionsRequest(request),
        result: {
          operation: 'browser' as const,
          result: {
            checkedAt: new Date(now).toISOString(),
            imageDataUrl: `data:image/jpeg;base64,${frame}`,
            imageRevision: 'a'.repeat(64),
            machineId,
            pageUrl: 'https://example.test',
            state: 'live' as const,
            threadId,
            turnId: 'turn-one'
          }
        }
      },
      type: 'codex.sessions.result' as const
    };
    const wire = JSON.stringify(message);

    expect(Buffer.byteLength(wire)).toBeLessThan(2 * 1024 * 1024);
    expect(isConnectorHubMessage(JSON.parse(wire))).toBe(true);

    const oversized = structuredClone(message);
    oversized.payload.result.result.imageDataUrl = `data:image/jpeg;base64,${
      Buffer.alloc(CODEX_BROWSER_MAXIMUM_IMAGE_BYTES + 1, 0x5a).toString('base64')
    }`;
    expect(isConnectorHubMessage(oversized)).toBe(false);
  });

  test('accepts a final read-only frame for an ended browser session', () => {
    const request = createCodexSessionsWireRequest({
      generation: 3,
      operation: 'browser',
      operationId: 'operation-browser-ended',
      payload: { machineId, threadId },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-browser-ended', now });
    const message = {
      id: 'command-browser-ended',
      payload: {
        binding: bindingForCodexSessionsRequest(request),
        result: {
          operation: 'browser' as const,
          result: {
            checkedAt: new Date(now).toISOString(),
            imageDataUrl: 'data:image/jpeg;base64,c2FmZQ==',
            imageRevision: 'b'.repeat(64),
            machineId,
            pageUrl: 'https://example.test',
            state: 'ended' as const,
            threadId,
            turnId: 'turn-one'
          }
        }
      },
      type: 'codex.sessions.result' as const
    };

    expect(isConnectorHubMessage(message)).toBe(true);
  });

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
              publishedAt: new Date(now).toISOString(),
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

  test('accepts daemon results only for the exact requested lifecycle operation', async () => {
    const { sent, socket } = fakeSocket([
      CODEX_DAEMON_CONNECTOR_CAPABILITY,
      CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY
    ]);
    try {
      const pending = requestConnectorCodexSessions('daemon', {
        machineId,
        operation: 'ensure',
        operationId: 'operation-daemon-ensure'
      }, {
        now,
        operationId: 'operation-daemon-ensure',
        signingKey: keys.privateKey,
        userId: 'user-owner'
      });
      const command = sent[0] as {
        id: string;
        payload: ReturnType<typeof createCodexSessionsWireRequest>;
      };
      const daemonResult = {
        evidence: {
          authenticated: true,
          checkedAt: new Date(now).toISOString(),
          compatible: true,
          environmentId: 'env_os_pc',
          installed: true,
          paired: true,
          reachable: true,
          remoteControlEnabled: true,
          remoteControlState: 'connected' as const,
          running: true,
          state: 'ready' as const
        },
        operation: 'restart' as 'ensure' | 'restart',
        operationId: 'operation-daemon-ensure',
        state: 'completed' as const
      };
      const message = {
        id: command.id,
        payload: {
          binding: bindingForCodexSessionsRequest(command.payload),
          result: { operation: 'daemon' as const, result: daemonResult }
        },
        type: 'codex.sessions.result' as const
      };
      const contradictory = structuredClone(message);
      contradictory.payload.result.result.evidence.authenticated = false;
      expect(isConnectorHubMessage(contradictory)).toBe(false);
      const contradictoryState = structuredClone(message);
      contradictoryState.payload.result.result.state = 'blocked';
      expect(isConnectorHubMessage(contradictoryState)).toBe(false);

      handleCodexSessionsConnectorMessage(machineId, message);
      expect(await Promise.race([
        pending.then(() => 'resolved'),
        Bun.sleep(5).then(() => 'pending')
      ])).toBe('pending');

      daemonResult.operation = 'ensure';
      handleCodexSessionsConnectorMessage(machineId, message);
      expect((await pending).result.operation).toBe('ensure');
      expect(connectorHasCapability(machineId, CODEX_SESSIONS_CONNECTOR_CAPABILITY)).toBe(true);

      const statusPending = requestConnectorCodexSessions('daemon', {
        machineId,
        operation: 'status',
        operationId: 'operation-daemon-status'
      }, {
        now,
        operationId: 'operation-daemon-status',
        signingKey: keys.privateKey,
        userId: 'user-owner'
      });
      const statusCommand = sent.at(-1) as {
        id: string;
        payload: ReturnType<typeof createCodexSessionsWireRequest>;
      };
      handleCodexSessionsConnectorMessage(machineId, {
        id: statusCommand.id,
        payload: {
          binding: bindingForCodexSessionsRequest(statusCommand.payload),
          result: {
            operation: 'daemon',
            result: {
              evidence: {
                authenticated: false,
                checkedAt: new Date(now + 1).toISOString(),
                cliVersion: '0.146.0',
                compatible: false,
                installed: true,
                paired: false,
                reachable: false,
                remoteControlEnabled: false,
                remoteControlState: 'unknown',
                running: false,
                state: 'stopped'
              },
              operation: 'status',
              operationId: 'operation-daemon-status',
              state: 'blocked'
            }
          }
        },
        type: 'codex.sessions.result'
      });
      await statusPending;
      expect(connectorHasCapability(machineId, CODEX_SESSIONS_CONNECTOR_CAPABILITY)).toBe(false);
      expect(connectorHasCapability(
        machineId,
        CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY
      )).toBe(false);
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

  test('does not send a model override to a connector with only the original session capability', async () => {
    const { sent, socket } = fakeSocket([CODEX_SESSIONS_CONNECTOR_CAPABILITY]);
    try {
      await expect(requestConnectorCodexSessions('continue', {
        machineId,
        message: 'Continue with another model',
        model: 'gpt-5-mini',
        operationId: 'operation-model-compatibility',
        threadId
      }, {
        generation: 1,
        signingKey: keys.privateKey,
        userId: 'user-owner'
      })).rejects.toThrow('does not provide Codex sessions');
      expect(sent).toEqual([]);
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('does not send reasoning settings to a connector with only model-selection support', async () => {
    const { sent, socket } = fakeSocket([
      CODEX_SESSIONS_CONNECTOR_CAPABILITY,
      CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY
    ]);
    try {
      await expect(requestConnectorCodexSessions('continue', {
        effort: 'high',
        machineId,
        message: 'Continue with complete catalogue settings',
        model: 'gpt-5.6-sol',
        operationId: 'operation-settings-compatibility',
        serviceTier: null,
        threadId
      }, {
        generation: 1,
        signingKey: keys.privateKey,
        userId: 'user-owner'
      })).rejects.toThrow('does not provide Codex sessions');
      expect(sent).toEqual([]);
      expect(CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY)
        .toBe('codex.sessions.model-settings.v1');
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('requires codex.sessions.inspect.v1 separately from ordinary session access', async () => {
    const { sent, socket } = fakeSocket([CODEX_SESSIONS_CONNECTOR_CAPABILITY]);
    try {
      await expect(requestConnectorCodexSessions('inspect', { machineId, threadId }, {
        generation: 1,
        signingKey: keys.privateKey,
        userId: 'user-owner'
      })).rejects.toThrow('does not provide Codex sessions');
      expect(sent).toEqual([]);
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('requires codex.sessions.browser.v1 before dispatching browser snapshots', async () => {
    const { sent, socket } = fakeSocket([CODEX_SESSIONS_CONNECTOR_CAPABILITY]);
    try {
      await expect(requestConnectorCodexSessions('browser', { machineId, threadId }, {
        generation: 1,
        signingKey: keys.privateKey,
        userId: 'user-owner'
      })).rejects.toThrow('does not provide Codex sessions');
      expect(sent).toEqual([]);
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('accepts a bound inspect result from the separately advertised capability', async () => {
    const { sent, socket } = fakeSocket([CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY]);
    try {
      const pending = requestConnectorCodexSessions('inspect', { machineId, threadId }, {
        now,
        operationId: 'operation-inspect-one',
        signingKey: keys.privateKey,
        userId: 'user-owner'
      });
      const command = sent[0] as {
        id: string;
        payload: ReturnType<typeof createCodexSessionsWireRequest>;
      };
      const result = {
        id: command.id,
        payload: {
          binding: bindingForCodexSessionsRequest(command.payload),
          result: {
            operation: 'inspect' as const,
            result: inspectionResult()
          }
        },
        type: 'codex.sessions.result' as const
      };
      expect(isConnectorHubMessage(result)).toBe(true);
      expect(handleCodexSessionsConnectorMessage(machineId, result)).toBe(true);
      expect(await pending).toEqual(result.payload.result);
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('rejects malformed revisions and ignores inspect evidence for another identity', async () => {
    const { sent, socket } = fakeSocket([CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY]);
    try {
      let resolved = false;
      const pending = requestConnectorCodexSessions('inspect', { machineId, threadId }, {
        now,
        operationId: 'operation-inspect-binding',
        signingKey: keys.privateKey,
        userId: 'user-owner'
      }).then((result) => {
        resolved = true;
        return result;
      });
      const command = sent[0] as {
        id: string;
        payload: ReturnType<typeof createCodexSessionsWireRequest>;
      };
      const binding = bindingForCodexSessionsRequest(command.payload);
      const malformedRevision = {
        id: command.id,
        payload: {
          binding,
          result: {
            operation: 'inspect' as const,
            result: inspectionResult({ sessionRevision: 'not-a-revision' })
          }
        },
        type: 'codex.sessions.result' as const
      };
      expect(isConnectorHubMessage(malformedRevision)).toBe(false);

      const mismatchedIdentity = {
        id: command.id,
        payload: {
          binding,
          result: {
            operation: 'inspect' as const,
            result: inspectionResult({ machineId: 'different-machine' })
          }
        },
        type: 'codex.sessions.result' as const
      };
      expect(isConnectorHubMessage(mismatchedIdentity)).toBe(true);
      expect(handleCodexSessionsConnectorMessage(machineId, mismatchedIdentity)).toBe(true);
      await Bun.sleep(0);
      expect(resolved).toBe(false);

      const valid = {
        id: command.id,
        payload: {
          binding,
          result: {
            operation: 'inspect' as const,
            result: inspectionResult()
          }
        },
        type: 'codex.sessions.result' as const
      };
      handleCodexSessionsConnectorMessage(machineId, valid);
      expect((await pending).operation).toBe('inspect');
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
  test('executes only the signed device authorization payload', async () => {
    const calls: unknown[] = [];
    const dispatcher = new CodexSessionsConnectorDispatcher({
      authorization: {
        async close() {},
        async execute(request) {
          calls.push(request);
          return {
            deadlineAt: '2026-07-24T00:15:00.000Z',
            state: 'pending',
            userCode: 'ABCD-1234',
            verificationUrl: 'https://auth.openai.com/codex/device'
          };
        }
      },
      expectedMachineId: machineId,
      manager: new DispatchManager() as unknown as CodexSessionManager,
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(21);
    const request = createCodexSessionsWireRequest({
      generation: 21,
      operation: 'authorization',
      operationId: 'codex:login:operation-one',
      payload: {
        action: 'start',
        machineId,
        operationId: 'codex:login:operation-one'
      },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-login-dispatch', now: Date.now() });
    const messages: ConnectorHubMessage[] = [];
    dispatcher.dispatch('command-login', request, (message) => messages.push(message), () => {
      throw new Error('authorization grant was rejected');
    });
    await Bun.sleep(0);
    expect(calls).toEqual([request.payload]);
    expect(messages).toEqual([expect.objectContaining({
      id: 'command-login',
      payload: expect.objectContaining({
        binding: expect.objectContaining({
          machineId,
          operation: 'authorization',
          operationId: 'codex:login:operation-one',
          userId: 'user-owner'
        }),
        result: {
          operation: 'authorization',
          result: expect.objectContaining({ state: 'pending', userCode: 'ABCD-1234' })
        }
      }),
      type: 'codex.sessions.result'
    })]);
    expect(isConnectorHubMessage(JSON.parse(JSON.stringify(messages[0])))).toBe(true);
    expect(isConnectorHubMessage(JSON.parse(JSON.stringify({
      id: 'command-login-error',
      payload: {
        binding: bindingForCodexSessionsRequest(request),
        error: { code: 'unavailable' }
      },
      type: 'codex.sessions.error'
    })))).toBe(true);
    dispatcher.close();
  });

  test('publishes fresh registry evidence before returning a daemon result', async () => {
    const order: string[] = [];
    const dispatcher = new CodexSessionsConnectorDispatcher({
      daemonManager: {
        async execute(operation, operationId) {
          return {
            evidence: {
              authenticated: true,
              checkedAt: new Date().toISOString(),
              compatible: true,
              environmentId: 'env_os_pc',
              installed: true,
              paired: true,
              reachable: true,
              remoteControlEnabled: true,
              remoteControlState: 'connected',
              running: true,
              state: 'ready'
            },
            operation,
            operationId,
            state: 'completed'
          };
        }
      },
      expectedMachineId: machineId,
      manager: new DispatchManager() as unknown as CodexSessionManager,
      onDaemonChanged: async () => {
        order.push('registry');
      },
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(22);
    const request = createCodexSessionsWireRequest({
      generation: 22,
      operation: 'daemon',
      operationId: 'operation-daemon-publish',
      payload: {
        machineId,
        operation: 'ensure',
        operationId: 'operation-daemon-publish'
      },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-daemon-publish', now: Date.now() });

    dispatcher.dispatch('command-daemon-publish', request, () => {
      order.push('result');
    }, () => {
      throw new Error('daemon grant was rejected');
    });
    await Bun.sleep(0);

    expect(order).toEqual(['registry', 'result']);
    dispatcher.close();
  });

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
  test('advertises sessions only when the shared managed daemon is ready', async () => {
    const backend = createLocalProjectSpaceBackend({ connectorMachineId: machineId });
    const registry = await backend.getConnectorProjectRegistry();
    expect(registry.connector.capabilities?.includes(CODEX_DAEMON_CONNECTOR_CAPABILITY))
      .toBe(
        process.platform === 'linux' &&
        process.env.PROJECT_SPACE_INSTALL_SOURCE === 'managed'
      );
    const sharedReady = registry.connector.daemon?.state === 'ready';
    expect(registry.connector.capabilities?.includes(CODEX_SESSIONS_CONNECTOR_CAPABILITY))
      .toBe(sharedReady);
    expect(registry.connector.capabilities?.includes(CODEX_SESSIONS_BROWSER_CONNECTOR_CAPABILITY))
      .toBe(sharedReady);
    expect(registry.connector.capabilities?.includes(CODEX_SESSIONS_INSPECT_CONNECTOR_CAPABILITY))
      .toBe(sharedReady);
    expect(registry.connector.capabilities?.includes(CODEX_SESSIONS_MODEL_SELECTION_CONNECTOR_CAPABILITY))
      .toBe(sharedReady);
    expect(registry.connector.capabilities?.includes(CODEX_SESSIONS_MODEL_SETTINGS_CONNECTOR_CAPABILITY))
      .toBe(sharedReady);
  }, 15_000);
});
