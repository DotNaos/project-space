import { mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../src/shared/workspace-runtime-codex-api';
import type { CodexSessionManager } from '../server/codex-sessions';
import type { CodexSessionEventListener } from '../server/codex-sessions/contracts';
import { WorkspaceRuntimeCodexHostController } from '../server/workspace-runtime-codex-host/controller';

const workspaceId = 'ws_0123456789abcdef01234567';
const environmentId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const ownerUserId = 'user_owner';

describe('Workspace Runtime Codex host controller', () => {
  test('advertises readiness only after the shared manager starts', async () => {
    const fixture = await createFixture();
    let started = false;
    const controller = fixture.controller(() => fakeManager({
      async listLoadedThreads() {
        started = true;
        return { data: [] };
      }
    }));
    const ready = await controller.start();
    expect(started).toBe(true);
    expect(ready).toEqual({
      acceptedCommandSequence: 0,
      capability: 'runtime.codex.v1',
      lastEventSequence: 0,
      state: 'ready'
    });
    await controller.stop();
  });

  test('durably replays an exact command and fences changed or stale bindings', async () => {
    const fixture = await createFixture();
    const first = fixture.controller(() => fakeManager());
    await first.start();
    first.bind('socket-one', 0);
    const command = runtimeStartCommand('socket-one');
    await first.command(command);
    expect(fixture.messages.map((message) => message.type)).toEqual([
      'runtime.codex.command-accepted', 'runtime.codex.result'
    ]);
    await first.stop();

    fixture.messages.length = 0;
    const restarted = fixture.controller(() => fakeManager());
    const ready = await restarted.start();
    expect(ready.acceptedCommandSequence).toBe(1);
    restarted.bind('socket-two', 0);
    await restarted.command({ ...command, sessionId: 'socket-two' });
    expect(fixture.messages).toHaveLength(2);
    expect(fixture.messages.every((message) => message.sessionId === 'socket-two')).toBe(true);
    expect(fixture.messages[0]).toMatchObject({ replayed: true, type: 'runtime.codex.command-accepted' });

    await restarted.command({
      ...command,
      operationId: 'operation.changed',
      request: { operationId: 'operation.changed' },
      sessionId: 'socket-two'
    });
    expect(fixture.messages.at(-1)).toMatchObject({
      code: 'invalid_command',
      type: 'runtime.codex.error'
    });

    await restarted.command({
      ...runtimeStartCommand('socket-two'),
      commandId: 'command-stale',
      commandSequence: 2,
      generation: '33333333-3333-4333-8333-333333333333'
    });
    expect(fixture.messages.at(-1)).toMatchObject({
      code: 'unavailable',
      type: 'runtime.codex.error'
    });
    await restarted.stop();
  });

  test('journals sanitized stream events and resumes them on a replacement socket', async () => {
    const fixture = await createFixture();
    let listener: CodexSessionEventListener | undefined;
    const first = fixture.controller(() => fakeManager({
      subscribe(next: CodexSessionEventListener) {
        listener = next;
        return () => true;
      }
    }));
    await first.start();
    first.bind('socket-one', 0);
    const machineId = `workspace-runtime:${createHash('sha256').update([
      workspaceId, environmentId
    ].join('\0')).digest('hex').slice(0, 32)}`;
    await first.command({
      ...runtimeStartCommand('socket-one'),
      kind: 'stream-start',
      operationId: 'operation.stream',
      request: { machineId, threadId: 'thread-one' },
      targetThreadId: 'thread-one'
    });
    listener?.({
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: { delta: 'safe update', itemId: 'item-one', threadId: 'thread-one', turnId: 'turn-one' }
    });
    await waitForMessage(fixture.messages, 'runtime.codex.event');
    expect(fixture.messages.at(-1)).toMatchObject({
      eventSequence: 1,
      type: 'runtime.codex.event'
    });
    await first.stop();

    fixture.messages.length = 0;
    const restarted = fixture.controller(() => fakeManager());
    expect((await restarted.start()).lastEventSequence).toBe(1);
    restarted.bind('socket-two', 0);
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]).toMatchObject({
      eventSequence: 1,
      sessionId: 'socket-two',
      type: 'runtime.codex.event'
    });
    await restarted.stop();
  });

  test('bounds controller shutdown when the shared manager does not close', async () => {
    const fixture = await createFixture();
    const controller = fixture.controller(() => fakeManager({
      close: () => new Promise<void>(() => {})
    }), 10);
    await controller.start();
    const startedAt = performance.now();
    await controller.stop();
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'project-runtime-codex-host-'));
  const messages: WorkspaceRuntimeCodexMessage[] = [];
  return {
    controller(createManager: () => CodexSessionManager, stopTimeoutMs?: number) {
      return new WorkspaceRuntimeCodexHostController({
        binaryPath: '/verified/codex',
        codexHome: join(directory, 'codex-home'),
        createManager,
        emit: (message) => messages.push(message),
        environmentId,
        generation,
        journalPath: join(directory, 'host-journal.json'),
        operationSnapshotPath: join(directory, 'codex-operations.json'),
        ownerUserId,
        ...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs }),
        workspaceId
      });
    },
    messages
  };
}

function runtimeStartCommand(sessionId: string): WorkspaceRuntimeCodexCommand {
  return {
    actorId: 'actor-owner',
    actorKind: 'human',
    actorUserId: ownerUserId,
    commandId: 'command-start',
    commandSequence: 1,
    environmentId,
    generation,
    kind: 'runtime-start',
    operationId: 'operation.start',
    request: { operationId: 'operation.start' },
    schemaVersion: 1,
    sessionId,
    type: 'runtime.codex.command',
    workspaceId
  };
}

function fakeManager(overrides: Record<string, unknown> = {}) {
  return {
    close: async () => {},
    listLoadedThreads: async () => ({ data: [] }),
    subscribe: () => () => true,
    ...overrides
  } as unknown as CodexSessionManager;
}

async function waitForMessage(messages: WorkspaceRuntimeCodexMessage[], type: WorkspaceRuntimeCodexMessage['type']) {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    if (messages.at(-1)?.type === type) return;
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${type}.`);
}
