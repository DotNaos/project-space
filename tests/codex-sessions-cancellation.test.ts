import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  CODEX_SESSIONS_CONNECTOR_CAPABILITY,
  createCodexSessionsWireRequest
} from '../server/codex-sessions-connector-contract';
import type { ConnectorHubMessage } from '../server/connector-command-protocol';
import {
  registerConnectorSession,
  removeConnectorSession
} from '../server/connector-command-session-registry';
import { bindingForCodexSessionsRequest } from '../server/codex-sessions/connector-channel';
import { CodexSessionsConnectorDispatcher } from '../server/codex-sessions/connector-dispatch';
import {
  CodexConnectorOutcomeUnknownError,
  handleCodexSessionsConnectorMessage,
  requestConnectorCodexSessions
} from '../server/codex-sessions/connector-hub';
import type {
  CodexChildProcess,
  CodexRpcId,
  CodexSessionEventListener,
  CodexThreadListInput
} from '../server/codex-sessions/contracts';
import {
  CodexAppServerRequestCancelledError,
  CodexSessionManager
} from '../server/codex-sessions';

const keys = generateKeyPairSync('ed25519');

function registeredSocket(machineId: string) {
  const sent: Array<Record<string, unknown>> = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) {
      sent.push(JSON.parse(value) as Record<string, unknown>);
    }
  } as unknown as WebSocket;
  registerConnectorSession(
    machineId,
    socket,
    'test-token',
    [CODEX_SESSIONS_CONNECTOR_CAPABILITY]
  );
  return { sent, socket };
}

async function waitFor(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

describe('Codex read-only cancellation', () => {
  test('sends machine cancellation when a hosted list times out and ignores a late result', async () => {
    const machineId = 'codex-cancel-hosted';
    const { sent, socket } = registeredSocket(machineId);
    try {
      const pending = requestConnectorCodexSessions('list', { machineId }, {
        operationId: 'operation-list-timeout',
        signingKey: keys.privateKey,
        timeoutMs: 5,
        userId: 'user-owner'
      });
      const command = sent[0] as {
        id: string;
        payload: ReturnType<typeof createCodexSessionsWireRequest>;
      };

      await expect(pending).rejects.toBeInstanceOf(CodexConnectorOutcomeUnknownError);
      expect(sent).toContainEqual({ id: command.id, type: 'connector.command.cancel' });

      const handled = handleCodexSessionsConnectorMessage(machineId, {
        id: command.id,
        payload: {
          binding: bindingForCodexSessionsRequest(command.payload),
          result: {
            operation: 'list',
            result: {
              checkedAt: new Date().toISOString(),
              machine: { id: machineId, name: machineId, online: true },
              publishedAt: new Date().toISOString(),
              sessions: []
            }
          }
        },
        type: 'codex.sessions.result'
      });
      expect(handled).toBe(true);
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('does not cancel a timed-out mutation or turn its uncertain outcome into success', async () => {
    const machineId = 'codex-cancel-mutation';
    const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';
    const { sent, socket } = registeredSocket(machineId);
    try {
      const pending = requestConnectorCodexSessions('continue', {
        machineId,
        message: 'Continue safely',
        operationId: 'operation-continue-timeout',
        threadId
      }, {
        signingKey: keys.privateKey,
        timeoutMs: 5,
        userId: 'user-owner'
      });
      await expect(pending).rejects.toBeInstanceOf(CodexConnectorOutcomeUnknownError);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.type).toBe('codex.sessions.command');
    } finally {
      removeConnectorSession(machineId, socket);
    }
  });

  test('removes a cancelled machine execution and suppresses its late completion', async () => {
    const machineId = 'codex-cancel-dispatch';
    let completeList!: () => void;
    let listSignal: AbortSignal | undefined;
    const manager = {
      listLoadedThreads: async () => ({ data: [] }),
      listThreads: (_input: CodexThreadListInput, signal?: AbortSignal) => {
        listSignal = signal;
        return new Promise<{ data: []; nextCursor: null }>((resolve) => {
          completeList = () => resolve({ data: [], nextCursor: null });
        });
      },
      readThread: async () => { throw new Error('not used'); },
      subscribe: (_listener: CodexSessionEventListener) => () => true
    };
    const dispatcher = new CodexSessionsConnectorDispatcher({
      expectedMachineId: machineId,
      manager: manager as unknown as CodexSessionManager,
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(4);
    const request = createCodexSessionsWireRequest({
      generation: 4,
      operation: 'list',
      operationId: 'operation-dispatch-cancel',
      payload: { machineId },
      userId: 'user-owner'
    }, keys.privateKey);
    const messages: ConnectorHubMessage[] = [];

    dispatcher.dispatch('command-cancel', request, (message) => messages.push(message), () => {});
    await waitFor(() => Boolean(listSignal), 'the machine list request');
    expect(dispatcher.cancel('command-cancel')).toBe(true);
    expect(listSignal?.aborted).toBe(true);
    expect(dispatcher.cancel('command-cancel')).toBe(false);

    completeList();
    await Bun.sleep(0);
    expect(messages).toEqual([]);
    dispatcher.close();
  });
});

type RpcMessage = {
  id?: CodexRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

class CancellationCodexProcess extends EventEmitter implements CodexChildProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly requests: RpcMessage[] = [];

  constructor() {
    super();
    const lines = createInterface({ input: this.stdin });
    lines.on('line', (line) => {
      const request = JSON.parse(line) as RpcMessage;
      this.requests.push(request);
      if (request.method === 'initialize') this.send({ id: request.id, result: {} });
      if (request.method === 'thread/loaded/list') {
        this.send({ id: request.id, result: { data: [] } });
      }
    });
  }

  send(message: RpcMessage) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM') {
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    queueMicrotask(() => this.emit('close'));
    return true;
  }
}

test('stdio cancellation removes the pending RPC, notifies App Server, and ignores its late reply', async () => {
  const process = new CancellationCodexProcess();
  const manager = new CodexSessionManager({ processFactory: () => process });
  const controller = new AbortController();
  try {
    const pending = manager.listThreads({}, controller.signal);
    await waitFor(
      () => process.requests.some((request) => request.method === 'thread/list'),
      'the App Server list request'
    );
    const listRequest = process.requests.find((request) => request.method === 'thread/list')!;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerRequestCancelledError);
    await waitFor(
      () => process.requests.some((request) => request.method === '$/cancelRequest'),
      'the App Server cancellation notification'
    );
    expect(process.requests).toContainEqual({
      method: '$/cancelRequest',
      params: { id: listRequest.id }
    });

    process.send({
      id: listRequest.id,
      result: { data: [{ id: 'late-thread' }], nextCursor: null }
    });
    await expect(manager.listLoadedThreads()).resolves.toEqual({ data: [] });
  } finally {
    await manager.close();
  }
});
