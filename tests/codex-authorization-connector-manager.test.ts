import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';

import { CodexDeviceAuthorizationManager } from '../server/codex-authorization/connector-manager';
import type { CodexAuthorizationOperationRecord } from '../server/codex-authorization/operation-store';
import type { CodexChildProcess } from '../server/codex-sessions/contracts';
import { createProjectConnectorCodexAuthorizationManager } from '../server/project-connector-codex-runtime';

type RpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

class FakeCodexProcess extends EventEmitter implements CodexChildProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly requests: RpcMessage[] = [];

  constructor(private readonly handler: (message: RpcMessage, server: FakeCodexProcess) => void) {
    super();
    createInterface({ input: this.stdin }).on('line', (line) => {
      const message = JSON.parse(line) as RpcMessage;
      this.requests.push(message);
      this.handler(message, this);
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

function authorizationProcess(options: {
  authorized?: () => boolean;
  omitAccount?: boolean;
  verificationUrl?: string;
} = {}) {
  return new FakeCodexProcess((message, server) => {
    if (message.method === 'initialize') server.send({ id: message.id, result: {} });
    if (message.method === 'account/read') {
      server.send({
        id: message.id,
        result: {
          ...(!options.omitAccount
            ? { account: options.authorized?.() ? { type: 'chatgpt' } : null }
            : {}),
          requiresOpenaiAuth: true
        }
      });
    }
    if (message.method === 'account/login/start') {
      server.send({
        id: message.id,
        result: {
          loginId: 'login-internal-1',
          type: 'chatgptDeviceCode',
          userCode: 'ABCD-1234',
          verificationUrl:
            options.verificationUrl ?? 'https://auth.openai.com/codex/device'
        }
      });
    }
    if (message.method === 'account/login/cancel') {
      server.send({ id: message.id, result: { status: 'canceled' } });
    }
  });
}

describe('managed Codex device authorization', () => {
  test('wires the ready transition through the production connector factory', async () => {
    let readyTransitions = 0;
    const process = authorizationProcess({ authorized: () => true });
    const manager = createProjectConnectorCodexAuthorizationManager(
      {},
      'connector-wsl',
      {
        onReady: () => { readyTransitions += 1; },
        processFactory: () => process
      }
    );
    try {
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:production-factory'
      })).resolves.toEqual({ state: 'ready' });
      expect(readyTransitions).toBe(1);
    } finally {
      await manager.close();
    }
  });

  test('starts one constrained device flow and replays the same operation', async () => {
    const process = authorizationProcess();
    const manager = new CodexDeviceAuthorizationManager({
      now: () => Date.parse('2026-07-24T00:00:00.000Z'),
      processFactory: () => process
    });
    try {
      const request = {
        action: 'start' as const,
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      };
      const first = await manager.execute(request);
      const replayed = await manager.execute(request);
      expect(first).toEqual(replayed);
      expect(first).toEqual({
        deadlineAt: '2026-07-24T00:15:00.000Z',
        state: 'pending',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://auth.openai.com/codex/device'
      });
      expect(process.requests.filter((entry) => entry.method === 'account/login/start')).toHaveLength(1);
      expect(process.requests.find((entry) => entry.method === 'account/login/start')?.params)
        .toEqual({ type: 'chatgptDeviceCode' });
    } finally {
      await manager.close();
    }
  });

  test('does not let another operation replace a pending login', async () => {
    const process = authorizationProcess();
    const manager = new CodexDeviceAuthorizationManager({ processFactory: () => process });
    try {
      await manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      });
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-two'
      })).rejects.toThrow('already active');
      expect(process.requests.filter((entry) => entry.method === 'account/login/start')).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('does not treat an incomplete account response as authorized', async () => {
    const process = authorizationProcess({ omitAccount: true });
    const manager = new CodexDeviceAuthorizationManager({ processFactory: () => process });
    try {
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toMatchObject({ state: 'pending' });
      expect(process.requests.filter((entry) => entry.method === 'account/login/start')).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('reconciles completion through account state without exposing account details', async () => {
    let authorized = false;
    let readyTransitions = 0;
    const process = authorizationProcess({ authorized: () => authorized });
    const manager = new CodexDeviceAuthorizationManager({
      onReady: () => { readyTransitions += 1; },
      processFactory: () => process
    });
    try {
      await manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      });
      authorized = true;
      process.send({
        method: 'account/login/completed',
        params: { error: null, loginId: 'login-internal-1', success: true }
      });
      await expect(manager.execute({
        action: 'status',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toEqual({ state: 'ready' });
      await expect(manager.execute({
        action: 'status',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toEqual({ state: 'ready' });
      expect(readyTransitions).toBe(1);
    } finally {
      await manager.close();
    }
  });

  test('returns ambiguous for an untrusted response and sends no second login', async () => {
    const process = authorizationProcess({
      verificationUrl: 'https://example.com/codex/device?token=secret'
    });
    const manager = new CodexDeviceAuthorizationManager({ processFactory: () => process });
    try {
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toEqual({ state: 'ambiguous' });
      expect(process.requests.filter((entry) => entry.method === 'account/login/start')).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('cancels only the internally bound upstream login id', async () => {
    const process = authorizationProcess();
    const manager = new CodexDeviceAuthorizationManager({ processFactory: () => process });
    try {
      await manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      });
      await expect(manager.execute({
        action: 'cancel',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toEqual({ state: 'cancelled' });
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toEqual({ state: 'cancelled' });
      expect(process.requests.find((entry) => entry.method === 'account/login/cancel')?.params)
        .toEqual({ loginId: 'login-internal-1' });
      expect(process.requests.filter((entry) => entry.method === 'account/login/start')).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('expires and cancels the upstream login at the advertised deadline', async () => {
    let now = Date.parse('2026-07-24T00:00:00.000Z');
    const process = authorizationProcess();
    const manager = new CodexDeviceAuthorizationManager({
      now: () => now,
      processFactory: () => process
    });
    try {
      await manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      });
      now = Date.parse('2026-07-24T00:15:00.000Z');
      await expect(manager.execute({
        action: 'status',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toEqual({ state: 'expired' });
      expect(process.requests.find((entry) => entry.method === 'account/login/cancel')?.params)
        .toEqual({ loginId: 'login-internal-1' });
    } finally {
      await manager.close();
    }
  });

  test('reconciles a not-found cancellation instead of claiming it succeeded', async () => {
    let authorized = false;
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'account/read') {
        server.send({
          id: message.id,
          result: {
            account: authorized ? { type: 'chatgpt' } : null,
            requiresOpenaiAuth: true
          }
        });
      }
      if (message.method === 'account/login/start') {
        server.send({
          id: message.id,
          result: {
            loginId: 'login-internal-1',
            type: 'chatgptDeviceCode',
            userCode: 'ABCD-1234',
            verificationUrl: 'https://auth.openai.com/codex/device'
          }
        });
      }
      if (message.method === 'account/login/cancel') {
        server.send({ id: message.id, result: { status: 'notFound' } });
      }
    });
    const manager = new CodexDeviceAuthorizationManager({ processFactory: () => process });
    try {
      await manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      });
      await expect(manager.execute({
        action: 'cancel',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toEqual({ state: 'ambiguous' });
    } finally {
      await manager.close();
    }

    const readyProcess = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'account/read') {
        server.send({
          id: message.id,
          result: {
            account: authorized ? { type: 'chatgpt' } : null,
            requiresOpenaiAuth: true
          }
        });
      }
      if (message.method === 'account/login/start') {
        server.send({
          id: message.id,
          result: {
            loginId: 'login-internal-1',
            type: 'chatgptDeviceCode',
            userCode: 'ABCD-1234',
            verificationUrl: 'https://auth.openai.com/codex/device'
          }
        });
      }
      if (message.method === 'account/login/cancel') {
        authorized = true;
        server.send({ id: message.id, result: { status: 'notFound' } });
      }
    });
    const readyManager = new CodexDeviceAuthorizationManager({
      processFactory: () => readyProcess
    });
    try {
      await readyManager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-ready'
      });
      await expect(readyManager.execute({
        action: 'cancel',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-ready'
      })).resolves.toEqual({ state: 'ready' });
    } finally {
      await readyManager.close();
    }
  });

  test('enforces the deadline even when no client polls status', async () => {
    const process = authorizationProcess();
    const manager = new CodexDeviceAuthorizationManager({
      authorizationDeadlineMs: 5,
      processFactory: () => process
    });
    try {
      await manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      });
      await Bun.sleep(20);
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      })).resolves.toEqual({ state: 'expired' });
      expect(process.requests.find((entry) => entry.method === 'account/login/cancel')?.params)
        .toEqual({ loginId: 'login-internal-1' });
    } finally {
      await manager.close();
    }
  });

  test('replays an abrupt-restart pending record without starting a second login', async () => {
    let snapshot: CodexAuthorizationOperationRecord[] = [];
    const persistence = {
      async persist(records: CodexAuthorizationOperationRecord[]) {
        snapshot = structuredClone(records);
      },
      snapshot
    };
    const firstProcess = authorizationProcess();
    const first = new CodexDeviceAuthorizationManager({
      operationPersistence: persistence,
      processFactory: () => firstProcess
    });
    await first.execute({
      action: 'start',
      machineId: 'connector-wsl',
      operationId: 'codex:login:operation-one'
    });
    expect(JSON.stringify(snapshot)).not.toContain('ABCD-1234');
    expect(JSON.stringify(snapshot)).not.toContain('login-internal-1');
    const crashSnapshot = structuredClone(snapshot);

    const second = new CodexDeviceAuthorizationManager({
      operationPersistence: { persist: async () => {}, snapshot: crashSnapshot },
      processFactory: () => {
        throw new Error('A replay must not start Codex.');
      }
    });
    await expect(second.execute({
      action: 'start',
      machineId: 'connector-wsl',
      operationId: 'codex:login:operation-two'
    })).resolves.toEqual({ state: 'ambiguous' });
    await expect(second.execute({
      action: 'start',
      machineId: 'connector-wsl',
      operationId: 'codex:login:operation-one'
    })).resolves.toEqual({ state: 'ambiguous' });
    await second.close();
    await first.close();
  });

  test('keeps a disconnected start RPC ambiguous and replayable', async () => {
    let snapshot: CodexAuthorizationOperationRecord[] = [];
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'account/read') {
        server.send({
          id: message.id,
          result: { account: null, requiresOpenaiAuth: true }
        });
      }
      if (message.method === 'account/login/start') {
        queueMicrotask(() => server.emit('close'));
      }
    });
    const manager = new CodexDeviceAuthorizationManager({
      operationPersistence: {
        async persist(records) { snapshot = structuredClone(records); },
        snapshot: []
      },
      processFactory: () => process
    });
    await expect(manager.execute({
      action: 'start',
      machineId: 'connector-wsl',
      operationId: 'codex:login:operation-one'
    })).resolves.toEqual({ state: 'ambiguous' });
    expect(snapshot.find((record) => record.operationId === 'codex:login:operation-one')?.state)
      .toBe('ambiguous');
    await manager.close();
  });

  test('bounds an unresponsive account read and permits a later retry', async () => {
    const stalled = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
    });
    const recovered = authorizationProcess();
    let launches = 0;
    const manager = new CodexDeviceAuthorizationManager({
      processFactory: () => launches++ === 0 ? stalled : recovered,
      rpcTimeoutMs: 5
    });
    try {
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-stalled'
      })).rejects.toThrow();
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-recovered'
      })).resolves.toMatchObject({ state: 'pending' });
      expect(stalled.signalCode).toBe('SIGTERM');
    } finally {
      await manager.close();
    }
  });

  test('keeps a timed out login start ambiguous and releases the execution queue', async () => {
    let now = Date.parse('2026-07-24T00:00:00.000Z');
    const stalled = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'account/read') {
        server.send({
          id: message.id,
          result: { account: null, requiresOpenaiAuth: true }
        });
      }
    });
    const recovered = authorizationProcess();
    let launches = 0;
    const manager = new CodexDeviceAuthorizationManager({
      now: () => now,
      processFactory: () => launches++ === 0 ? stalled : recovered,
      rpcTimeoutMs: 5
    });
    try {
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-stalled'
      })).resolves.toEqual({ state: 'ambiguous' });
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-new'
      })).resolves.toEqual({ state: 'ambiguous' });
      expect(launches).toBe(1);
      now = Date.parse('2026-07-24T00:15:00.000Z');
      await expect(manager.execute({
        action: 'status',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-stalled'
      })).resolves.toEqual({ state: 'expired' });
      await expect(manager.execute({
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-after-expiry'
      })).resolves.toMatchObject({ state: 'pending' });
      expect(recovered.requests.filter((entry) => entry.method === 'account/login/start'))
        .toHaveLength(1);
      expect(stalled.signalCode).toBe('SIGTERM');
    } finally {
      await manager.close();
    }
  });
});
