import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';

import type {
  CodexChildProcess,
  CodexStartTurnInput
} from '../server/codex-sessions/contracts';
import {
  CodexAppServerProtocolError,
  CodexOperationUncertainError,
  CodexSessionManager,
  CodexSessionValidationError
} from '../server/codex-sessions';

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };

class InteractiveServer extends EventEmitter implements CodexChildProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly received: Message[] = [];

  constructor() {
    super();
    createInterface({ input: this.stdin }).on('line', (line) => {
      const message = JSON.parse(line) as Message;
      this.received.push(message);
      if (message.method === 'initialize') this.send({ id: message.id, result: {} });
      if (message.method === 'thread/loaded/list') {
        this.send({ id: message.id, result: { data: [] } });
      }
      if (message.method === 'turn/start') {
        this.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      }
      if (message.result && message.id !== undefined) {
        queueMicrotask(() => this.send({
          method: 'serverRequest/resolved',
          params: { requestId: message.id, threadId: 'thread-1' }
        }));
      }
    });
  }

  send(message: Message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM') {
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    queueMicrotask(() => this.emit('close'));
    return true;
  }
}

describe('Codex app-server fixed contract', () => {
  test('responds only to the matching approval request and keeps request correlation', async () => {
    const server = new InteractiveServer();
    const manager = new CodexSessionManager({ processFactory: () => server });
    try {
      await manager.listLoadedThreads().catch(() => undefined);
      server.send({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'bun test', threadId: 'thread-1', turnId: 'turn-1' }
      });
      await Bun.sleep(0);

      expect(() => manager.respondToApproval({
        decision: 'accept',
        operationId: 'approve-1',
        requestId: 'approval-1',
        threadId: 'wrong-thread',
        turnId: 'turn-1'
      })).toThrow(CodexAppServerProtocolError);

      await manager.respondToApproval({
        decision: 'accept',
        operationId: 'approve-2',
        requestId: 'approval-1',
        threadId: 'thread-1',
        turnId: 'turn-1'
      });
      expect(server.received.find((message) => message.id === 'approval-1')?.result)
        .toEqual({ decision: 'accept' });
    } finally {
      await manager.close();
    }
  });

  test('grants only the permissions supplied by the pending App Server request', async () => {
    const server = new InteractiveServer();
    const manager = new CodexSessionManager({ processFactory: () => server });
    try {
      await manager.listLoadedThreads().catch(() => undefined);
      const requested = { fileSystem: { read: ['/safe/path'] }, network: ['example.com'] };
      server.send({
        id: 70,
        method: 'item/permissions/requestApproval',
        params: {
          permissions: requested,
          threadId: 'thread-1',
          turnId: 'turn-1'
        }
      });
      await Bun.sleep(0);
      await manager.respondToPermissions({
        grant: 'allRequested',
        operationId: 'permission-1',
        requestId: 70,
        scope: 'turn',
        threadId: 'thread-1',
        turnId: 'turn-1'
      });
      expect(server.received.find((message) => message.id === 70)?.result).toEqual({
        permissions: requested,
        scope: 'turn'
      });
    } finally {
      await manager.close();
    }
  });

  test('requires answers for exactly the pending questions', async () => {
    const server = new InteractiveServer();
    const manager = new CodexSessionManager({ processFactory: () => server });
    try {
      await manager.listLoadedThreads().catch(() => undefined);
      server.send({
        id: 'input-1',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [{ id: 'choice', question: 'Continue?' }],
          threadId: 'thread-1',
          turnId: 'turn-1'
        }
      });
      await Bun.sleep(0);
      expect(() => manager.respondToUserInput({
        answers: { unexpected: ['yes'] },
        operationId: 'input-operation-1',
        requestId: 'input-1',
        threadId: 'thread-1',
        turnId: 'turn-1'
      })).toThrow(CodexAppServerProtocolError);

      await manager.respondToUserInput({
        answers: { choice: ['yes'] },
        operationId: 'input-operation-2',
        requestId: 'input-1',
        threadId: 'thread-1',
        turnId: 'turn-1'
      });
      expect(server.received.find((message) => message.id === 'input-1')?.result).toEqual({
        answers: { choice: { answers: ['yes'] } }
      });
    } finally {
      await manager.close();
    }
  });

  test('validates identifiers and never forwards a browser-supplied cwd', async () => {
    const server = new InteractiveServer();
    const manager = new CodexSessionManager({ processFactory: () => server });
    await expect(manager.readThread('../../etc/passwd')).rejects.toBeInstanceOf(
      CodexSessionValidationError
    );
    await manager.startTurn({
      effort: 'high',
      model: 'gpt-5-mini',
      operationId: 'turn-operation',
      prompt: 'Hello',
      serviceTier: 'fast',
      threadId: 'thread-1',
      cwd: '/tmp/poison'
    } as CodexStartTurnInput & { cwd: string });
    expect(server.received.find((message) => message.method === 'turn/start')?.params)
      .toEqual({
        clientUserMessageId: 'turn-operation',
        input: [{ text: 'Hello', text_elements: [], type: 'text' }],
        effort: 'high',
        model: 'gpt-5-mini',
        serviceTier: 'fast',
        threadId: 'thread-1'
      });
    await manager.close();
  });

  test('persists uncertain operations until explicit reconciliation', async () => {
    const server = new InteractiveServer();
    const manager = new CodexSessionManager({ processFactory: () => server });
    const operation = manager.resumeThread({ operationId: 'resume-uncertain', threadId: 'thread-1' });
    await Bun.sleep(0);
    server.stdout.end();
    await expect(operation).rejects.toBeInstanceOf(CodexOperationUncertainError);
    expect(manager.operationSnapshot()).toEqual([{
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      operationId: 'resume-uncertain',
      result: undefined,
      state: 'uncertain'
    }]);
    expect(() => manager.resumeThread({
      operationId: 'resume-uncertain',
      threadId: 'thread-1'
    })).toThrow(CodexOperationUncertainError);
    await manager.reconcileOperationNotApplied('resume-uncertain');
    await manager.close();
  });
});
