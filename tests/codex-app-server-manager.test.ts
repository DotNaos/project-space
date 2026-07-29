import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';

import type { CodexChildProcess } from '../server/codex-sessions/contracts';
import {
  CodexAppServerProtocolError,
  CodexOperationConflictError,
  CodexOperationUncertainError,
  CodexSessionManager,
  CodexThreadActiveError
} from '../server/codex-sessions';
import { presentCodexTurns } from '../server/codex-sessions/public-presenter';

type RpcMessage = {
  id?: number | string;
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
    const lines = createInterface({ input: this.stdin });
    lines.on('line', (line) => {
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

  disconnect() {
    this.stdout.end();
    this.emit('close');
  }
}

function standardHandler(message: RpcMessage, server: FakeCodexProcess) {
  if (message.method === 'initialize') server.send({ id: message.id, result: { userAgent: 'test' } });
  if (message.method === 'thread/list') {
    server.send({
      id: message.id,
      result: {
        data: [{ id: 'thread-1', name: 'Stored thread', status: { type: 'notLoaded' } }],
        nextCursor: null
      }
    });
  }
  if (message.method === 'thread/loaded/list') {
    server.send({ id: message.id, result: { data: [] } });
  }
  if (message.method === 'thread/read') {
    server.send({
      id: message.id,
      result: { thread: { id: 'thread-1', status: { type: 'notLoaded' }, turns: [] } }
    });
  }
  if (message.method === 'thread/resume') {
    server.send({ id: message.id, result: { thread: { id: 'thread-1', status: { type: 'idle' } } } });
  }
  if (message.method === 'turn/start') {
    server.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
  }
  if (message.method === 'turn/steer') {
    server.send({ id: message.id, result: { turnId: 'turn-1' } });
  }
  if (message.method === 'turn/interrupt') server.send({ id: message.id, result: {} });
}

describe('Codex app-server session manager', () => {
  test('steers the exact active turn with text and local images', async () => {
    const process = new FakeCodexProcess(standardHandler);
    const manager = new CodexSessionManager({ processFactory: () => process });
    try {
      const result = await manager.steerTurn({
        expectedTurnId: 'turn-1',
        localImagePaths: ['/tmp/prototype.png'],
        operationId: 'operation-steer',
        prompt: 'Focus on this detail',
        threadId: 'thread-1'
      });
      expect(result).toEqual({ turnId: 'turn-1' });
      expect(process.requests.find((request) => request.method === 'turn/steer'))
        .toMatchObject({
          params: {
            clientUserMessageId: 'operation-steer',
            expectedTurnId: 'turn-1',
            input: [
              { text: 'Focus on this detail', text_elements: [], type: 'text' },
              { path: '/tmp/prototype.png', type: 'localImage' }
            ],
            threadId: 'thread-1'
          }
        });
    } finally {
      await manager.close();
    }
  });

  test('rejects oversized non-history responses instead of widening every protocol message', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/list') {
        server.send({
          id: message.id,
          result: { data: [], nextCursor: null, padding: 'x'.repeat(2_000_000) }
        });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });

    try {
      await expect(Promise.race([
        manager.listThreads(),
        Bun.sleep(250).then(() => {
          throw new Error('Oversized response rejection timed out.');
        })
      ])).rejects.toBeInstanceOf(CodexAppServerProtocolError);
    } finally {
      await manager.close();
    }
  });

  test('ignores buffered notifications after an oversized response closes the protocol', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/list') {
        const oversized = JSON.stringify({
          id: message.id,
          result: { data: [], nextCursor: null, padding: 'x'.repeat(2_000_000) }
        });
        const notification = JSON.stringify({
          method: 'item/agentMessage/delta',
          params: { delta: 'Must not escape', threadId: 'thread-1', turnId: 'turn-1' }
        });
        server.stdout.write(`${oversized}\n${notification}\n`);
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const events: unknown[] = [];
    manager.subscribe((event) => events.push(event));

    try {
      await expect(manager.listThreads()).rejects.toBeInstanceOf(CodexAppServerProtocolError);
      await Bun.sleep(0);
      expect(events).toEqual([]);
    } finally {
      await manager.close();
    }
  });

  test('keeps a sent mutation uncertain when an oversized response closes the protocol', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'turn/start') {
        server.send({
          id: message.id,
          result: { padding: 'x'.repeat(2_000_000), turn: { id: 'turn-1' } }
        });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const operation = {
      operationId: 'operation-uncertain',
      prompt: 'Continue safely',
      threadId: 'thread-1'
    };

    try {
      await expect(manager.startTurn(operation)).rejects.toBeInstanceOf(
        CodexOperationUncertainError
      );
      expect(manager.operationSnapshot()).toEqual([
        expect.objectContaining({
          operationId: operation.operationId,
          state: 'uncertain'
        })
      ]);
      expect(() => manager.startTurn(operation)).toThrow(CodexOperationUncertainError);
      expect(process.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('keeps an approval response uncertain when the protocol fails before confirmation', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/list') {
        server.send({ id: message.id, result: { data: [], nextCursor: null } });
      }
      if (!message.method && message.id === 'approval-1') {
        server.send({
          method: 'error',
          params: { padding: 'x'.repeat(2_000_000) }
        });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const operation = {
      decision: 'accept' as const,
      operationId: 'operation-approval',
      requestId: 'approval-1',
      threadId: 'thread-1',
      turnId: 'turn-1'
    };

    try {
      await manager.listThreads();
      process.send({
        id: operation.requestId,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: operation.threadId, turnId: operation.turnId }
      });
      await Bun.sleep(0);

      await expect(manager.respondToApproval(operation)).rejects.toBeInstanceOf(
        CodexOperationUncertainError
      );
      expect(manager.operationSnapshot()).toEqual([
        expect.objectContaining({
          operationId: operation.operationId,
          state: 'uncertain'
        })
      ]);
      expect(process.requests.filter((request) => (
        request.id === operation.requestId && !request.method
      ))).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('rejects history beyond the absolute response bound instead of hanging', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/read') {
        server.stdout.write(`${'x'.repeat(16 * 1024 * 1024 + 1)}\n`);
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });

    try {
      await expect(Promise.race([
        manager.readThread('thread-1'),
        Bun.sleep(1_000).then(() => {
          throw new Error('Absolute response bound rejection timed out.');
        })
      ])).rejects.toBeInstanceOf(CodexAppServerProtocolError);
    } finally {
      await manager.close();
    }
  });

  test('reads stored history when the App Server response exceeds the legacy line limit', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/read') {
        server.send({
          id: message.id,
          result: {
            thread: {
              id: 'thread-1',
              status: { type: 'notLoaded' },
              turns: [{
                id: 'turn-1',
                items: [
                  { content: [{ text: 'Original request', type: 'text' }], id: 'user-1', type: 'userMessage' },
                  {
                    id: 'tool-1',
                    result: { content: 'x'.repeat(2_000_000) },
                    status: 'completed',
                    tool: 'repository/read',
                    type: 'mcpToolCall'
                  },
                  { id: 'assistant-1', text: 'Stored answer', type: 'agentMessage' }
                ],
                status: 'completed'
              }]
            }
          }
        });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });

    try {
      const result = await Promise.race([
        manager.readThread('thread-1'),
        Bun.sleep(250).then(() => {
          throw new Error('Stored history read timed out.');
        })
      ]);

      expect(presentCodexTurns(result.thread)[0]?.items).toEqual([
        expect.objectContaining({ id: 'user-1', kind: 'user-message', text: 'Original request' }),
        expect.objectContaining({ id: 'tool-1', kind: 'mcp-tool' }),
        expect.objectContaining({ id: 'assistant-1', kind: 'agent-message', text: 'Stored answer' })
      ]);
    } finally {
      await manager.close();
    }
  });

  test('reuses one process and reads stored history without resuming it', async () => {
    const processes: FakeCodexProcess[] = [];
    const manager = new CodexSessionManager({
      processFactory: () => {
        const process = new FakeCodexProcess(standardHandler);
        processes.push(process);
        return process;
      }
    });

    try {
      expect((await manager.listThreads()).data[0]?.name).toBe('Stored thread');
      expect((await manager.readThread('thread-1')).thread.turns).toEqual([]);
      expect((await manager.listLoadedThreads()).data).toEqual([]);
      expect(processes).toHaveLength(1);
      expect(processes[0]?.requests.filter((request) => request.method === 'initialize')).toHaveLength(1);
      expect(processes[0]?.requests.some((request) => request.method === 'thread/resume')).toBe(false);
      expect(processes[0]?.requests.find((request) => request.method === 'thread/read')?.params)
        .toEqual({ includeTurns: true, threadId: 'thread-1' });
    } finally {
      await manager.close();
    }
  });

  test('starts one persistent writable thread with the exact cwd across duplicate retries', async () => {
    const threadId = '019f6d7a-42a7-7bc0-87b6-d41d8cd98f00';
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/start') {
        server.send({
          id: message.id,
          result: { thread: { ephemeral: false, id: threadId, status: { type: 'idle' } } }
        });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const operation = {
      cwd: '/worktrees/issue-262',
      operationId: 'start-thread-1'
    };

    try {
      const first = manager.startThread(operation);
      const retry = manager.startThread(operation);

      expect(await first).toEqual(await retry);
      expect(await first).toEqual({
        thread: { ephemeral: false, id: threadId, status: { type: 'idle' } }
      });
      expect(process.requests.filter((request) => request.method === 'thread/start')).toEqual([
        expect.objectContaining({
          params: {
            approvalPolicy: 'on-request',
            cwd: operation.cwd,
            ephemeral: false,
            sandbox: 'workspace-write'
          }
        })
      ]);
    } finally {
      await manager.close();
    }
  });

  test('keeps thread start uncertain when the App Server does not return a real thread id', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/start') {
        server.send({ id: message.id, result: { thread: { id: 'not-a-real-thread-id' } } });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const operation = {
      cwd: '/worktrees/issue-262',
      operationId: 'start-thread-invalid-id'
    };

    try {
      await expect(manager.startThread(operation)).rejects.toBeInstanceOf(
        CodexOperationUncertainError
      );
      expect(manager.operationSnapshot()).toEqual([
        expect.objectContaining({ operationId: operation.operationId, state: 'uncertain' })
      ]);
      expect(() => manager.startThread(operation)).toThrow(CodexOperationUncertainError);
      expect(process.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('keeps thread start uncertain unless persistence is explicitly confirmed', async () => {
    const threadId = '019f6d7a-42a7-7bc0-87b6-d41d8cd98f01';
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/start') {
        server.send({ id: message.id, result: { thread: { id: threadId } } });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });

    try {
      await expect(manager.startThread({
        cwd: '/worktrees/issue-262',
        operationId: 'start-thread-missing-persistence'
      })).rejects.toBeInstanceOf(CodexOperationUncertainError);
    } finally {
      await manager.close();
    }
  });

  test('keeps thread start uncertain when the App Server disconnects after receiving it', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/start') server.disconnect();
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const operation = {
      cwd: '/worktrees/issue-262',
      operationId: 'start-thread-disconnect'
    };

    try {
      await expect(manager.startThread(operation)).rejects.toBeInstanceOf(
        CodexOperationUncertainError
      );
      expect(manager.operationSnapshot()).toEqual([
        expect.objectContaining({ operationId: operation.operationId, state: 'uncertain' })
      ]);
      expect(() => manager.startThread(operation)).toThrow(CodexOperationUncertainError);
      expect(process.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('keeps thread start uncertain when its response exceeds the protocol bound', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/start') {
        server.send({
          id: message.id,
          result: {
            padding: 'x'.repeat(2_000_000),
            thread: { id: '019f6d7a-42a7-7bc0-87b6-d41d8cd98f00' }
          }
        });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const operation = {
      cwd: '/worktrees/issue-262',
      operationId: 'start-thread-oversized-response'
    };

    try {
      await expect(manager.startThread(operation)).rejects.toBeInstanceOf(
        CodexOperationUncertainError
      );
      expect(manager.operationSnapshot()).toEqual([
        expect.objectContaining({ operationId: operation.operationId, state: 'uncertain' })
      ]);
    } finally {
      await manager.close();
    }
  });

  test('keeps a malformed turn start uncertain without losing explicit settings', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'turn/start') {
        server.send({ id: message.id, result: { turn: { status: 'inProgress' } } });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const operation = {
      effort: 'high',
      model: 'gpt-5-mini',
      operationId: 'turn-invalid-id',
      prompt: 'Continue with the selected settings',
      serviceTier: 'fast',
      threadId: 'thread-1'
    };

    try {
      await expect(manager.startTurn(operation)).rejects.toBeInstanceOf(
        CodexOperationUncertainError
      );
      expect(manager.operationSnapshot()).toEqual([
        expect.objectContaining({ operationId: operation.operationId, state: 'uncertain' })
      ]);
      expect(() => manager.startTurn(operation)).toThrow(CodexOperationUncertainError);
      expect(process.requests.filter((request) => request.method === 'turn/start')).toEqual([
        expect.objectContaining({
          params: {
            clientUserMessageId: operation.operationId,
            effort: operation.effort,
            input: [{ text: operation.prompt, text_elements: [], type: 'text' }],
            model: operation.model,
            serviceTier: operation.serviceTier,
            threadId: operation.threadId
          }
        })
      ]);
    } finally {
      await manager.close();
    }
  });

  test('deduplicates turn starts and rejects a different new turn until completion', async () => {
    const process = new FakeCodexProcess(standardHandler);
    const manager = new CodexSessionManager({ processFactory: () => process });

    try {
      const first = manager.startTurn({
        operationId: 'operation-1',
        prompt: 'Run the tests',
        threadId: 'thread-1'
      });
      const retry = manager.startTurn({
        operationId: 'operation-1',
        prompt: 'Run the tests',
        threadId: 'thread-1'
      });
      expect(await first).toEqual(await retry);
      expect(process.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
      expect(JSON.stringify(manager.operationSnapshot())).not.toContain('Run the tests');

      await expect(manager.startTurn({
        operationId: 'operation-2',
        prompt: 'Do something else',
        threadId: 'thread-1'
      })).rejects.toBeInstanceOf(CodexThreadActiveError);

      process.send({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }
      });
      await Bun.sleep(0);
      await manager.startTurn({
        operationId: 'operation-3',
        prompt: 'Now continue',
        threadId: 'thread-1'
      });
      expect(process.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    } finally {
      await manager.close();
    }
  });

  test('sends validated local images as Codex image inputs', async () => {
    const process = new FakeCodexProcess(standardHandler);
    const manager = new CodexSessionManager({ processFactory: () => process });

    try {
      await manager.startTurn({
        localImagePaths: ['/tmp/prototype-one.png', '/tmp/prototype-two.jpg'],
        operationId: 'operation-with-images',
        prompt: 'Review these images',
        threadId: 'thread-1'
      });
      expect(process.requests.find((request) => request.method === 'turn/start')?.params)
        .toEqual({
          clientUserMessageId: 'operation-with-images',
          input: [
            { text: 'Review these images', text_elements: [], type: 'text' },
            { path: '/tmp/prototype-one.png', type: 'localImage' },
            { path: '/tmp/prototype-two.jpg', type: 'localImage' }
          ],
          threadId: 'thread-1'
        });
    } finally {
      await manager.close();
    }
  });

  test('rejects a new turn when resume reports that the stored thread is already active', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/resume') {
        server.send({
          id: message.id,
          result: {
            thread: {
              id: 'thread-1',
              status: { activeFlags: ['waitingOnApproval'], type: 'active' }
            }
          }
        });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    try {
      await manager.resumeThread({ operationId: 'resume-active', threadId: 'thread-1' });
      await expect(manager.startTurn({
        operationId: 'turn-after-active-resume',
        prompt: 'Do not start this',
        threadId: 'thread-1'
      })).rejects.toBeInstanceOf(CodexThreadActiveError);
      expect(process.requests.some((request) => request.method === 'turn/start')).toBe(false);
    } finally {
      await manager.close();
    }
  });

  test('keeps a mismatched resumed thread uncertain and fences retry', async () => {
    const process = new FakeCodexProcess((message, server) => {
      if (message.method === 'initialize') server.send({ id: message.id, result: {} });
      if (message.method === 'thread/resume') {
        server.send({
          id: message.id,
          result: { thread: { id: 'thread-other', status: { type: 'idle' } } }
        });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    const operation = { operationId: 'resume-wrong-thread', threadId: 'thread-1' };

    try {
      await expect(manager.resumeThread(operation)).rejects.toBeInstanceOf(
        CodexOperationUncertainError
      );
      expect(manager.operationSnapshot()).toEqual([
        expect.objectContaining({ operationId: operation.operationId, state: 'uncertain' })
      ]);
      expect(() => manager.resumeThread(operation)).toThrow(CodexOperationUncertainError);
      expect(process.requests.filter((request) => request.method === 'thread/resume'))
        .toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('rejects operation-id reuse with changed content', async () => {
    const manager = new CodexSessionManager({
      processFactory: () => new FakeCodexProcess(standardHandler)
    });
    try {
      await manager.resumeThread({ operationId: 'resume-1', threadId: 'thread-1' });
      expect(() => manager.resumeThread({ operationId: 'resume-1', threadId: 'thread-2' }))
        .toThrow(CodexOperationConflictError);
    } finally {
      await manager.close();
    }
  });

  test('starts a fresh long-lived process after an App Server restart', async () => {
    const processes: FakeCodexProcess[] = [];
    const manager = new CodexSessionManager({
      processFactory: () => {
        const process = new FakeCodexProcess(standardHandler);
        processes.push(process);
        return process;
      }
    });
    try {
      await manager.listThreads();
      processes[0]?.disconnect();
      await Bun.sleep(0);
      await manager.listThreads();
      expect(processes).toHaveLength(2);
      expect(processes[1]?.requests.filter((request) => request.method === 'initialize'))
        .toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('streams only allowlisted events and redacts command output and sensitive fields', async () => {
    const process = new FakeCodexProcess(standardHandler);
    const manager = new CodexSessionManager({ processFactory: () => process });
    const events: unknown[] = [];
    manager.subscribe((event) => events.push(event));
    try {
      await manager.listThreads();
      process.send({
        method: 'item/commandExecution/outputDelta',
        params: { delta: 'TOKEN=secret', env: { TOKEN: 'secret' }, threadId: 'thread-1' }
      });
      process.send({ method: 'config/read', params: { token: 'secret' } });
      process.send({
        method: 'item/agentMessage/delta',
        params: { delta: 'Visible response', threadId: 'thread-1', turnId: 'turn-1' }
      });
      process.send({
        method: 'item/completed',
        params: {
          item: { aggregatedOutput: 'another-secret', id: 'item-1', type: 'commandExecution' },
          threadId: 'thread-1',
          turnId: 'turn-1'
        }
      });
      process.send({
        method: 'error',
        params: {
          error: { additionalDetails: 'hidden-secret', message: 'token is hidden-secret' },
          threadId: 'thread-1',
          turnId: 'turn-1'
        }
      });
      await Bun.sleep(0);

      expect(events).toHaveLength(4);
      expect(JSON.stringify(events)).not.toContain('TOKEN=secret');
      expect(JSON.stringify(events)).not.toContain('"secret"');
      expect(JSON.stringify(events)).not.toContain('another-secret');
      expect(JSON.stringify(events)).not.toContain('hidden-secret');
      expect(JSON.stringify(events)).toContain('Visible response');
    } finally {
      await manager.close();
    }
  });

  test('uses advertised permission profiles and captures live context usage', async () => {
    const process = new FakeCodexProcess((message, server) => {
      standardHandler(message, server);
      if (message.method === 'permissionProfile/list') {
        server.send({
          id: message.id,
          result: {
            data: [
              { allowed: true, description: 'Workspace access', id: ':workspace' },
              { allowed: true, description: 'Read only', id: ':read-only' }
            ],
            nextCursor: null
          }
        });
      }
      if (message.method === 'thread/settings/update') {
        server.send({ id: message.id, result: {} });
      }
    });
    const manager = new CodexSessionManager({ processFactory: () => process });
    try {
      expect(await manager.listPermissionProfiles()).toEqual({
        data: [
          { allowed: true, description: 'Workspace access', id: ':workspace' },
          { allowed: true, description: 'Read only', id: ':read-only' }
        ],
        nextCursor: null
      });
      await manager.updateThreadSettings({
        operationId: 'settings-1',
        permissionProfileId: ':read-only',
        threadId: 'thread-1'
      });
      process.send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          tokenUsage: {
            last: {
              cachedInputTokens: 400,
              inputTokens: 1_000,
              outputTokens: 200,
              reasoningOutputTokens: 100,
              totalTokens: 1_300
            },
            modelContextWindow: 10_000,
            total: {
              cachedInputTokens: 400,
              inputTokens: 1_000,
              outputTokens: 200,
              reasoningOutputTokens: 100,
              totalTokens: 1_300
            }
          },
          turnId: 'turn-1'
        }
      });
      await Bun.sleep(0);

      expect(process.requests.find((request) => request.method === 'thread/settings/update'))
        .toMatchObject({
          params: { permissions: ':read-only', threadId: 'thread-1' }
        });
      expect(manager.threadSettings('thread-1')).toEqual({
        permissionProfileId: ':read-only'
      });
      expect(manager.threadTokenUsage('thread-1')).toMatchObject({
        last: { inputTokens: 1_000 },
        modelContextWindow: 10_000
      });
    } finally {
      await manager.close();
    }
  });
});
