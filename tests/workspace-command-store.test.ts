import { describe, expect, test } from 'bun:test';
import type { StoredWorkspaceCommand } from '../server/workspace-command/contracts';
import { MemoryWorkspaceCommandStore } from '../server/workspace-command/store';

const command: StoredWorkspaceCommand = {
  allowNetwork: false,
  auditId: '11111111-1111-4111-8111-111111111111',
  commandId: '22222222-2222-4222-8222-222222222222', commandSha256: 'a'.repeat(64),
  connectorGeneration: 7, connectorId: 'connector-1', createdAt: '2026-08-09T12:00:00.000Z',
  environmentId: '33333333-3333-4333-8333-333333333333',
  executionId: '44444444-4444-4444-8444-444444444444', expectedHeadSha: 'b'.repeat(40),
  maxOutputBytes: 4_096, outputCursor: 0, ownerUserId: 'user-1', projectId: 'github:480',
  repositoryWritable: false,
  scope: 'workspace', state: 'queued', stderr: '', stdout: '',
  startOperationFingerprint: 'c'.repeat(64), startOperationId: 'workspace:start:001',
  targetReference: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa', timeoutSeconds: 30, truncated: false,
  updatedAt: '2026-08-09T12:00:00.000Z', workspaceId: '55555555-5555-4555-8555-555555555555',
  workspaceWritable: false
};

describe('workspace command store', () => {
  test('isolates owners, rejects identity drift, and advances output cursors only on change', async () => {
    const store = new MemoryWorkspaceCommandStore();
    expect(await store.create(command)).toBe('created');
    expect(await store.create(command)).toBe('replayed');
    expect(await store.create({ ...command, targetReference: 'wt_bbbbbbbbbbbbbbbbbbbbbbbb' })).toBe('conflict');
    expect(await store.create({ ...command, projectId: 'github:other' })).toBe('conflict');
    expect(await store.create({ ...command, repositoryWritable: true })).toBe('conflict');
    expect(await store.read('user-2', command.commandId)).toBeUndefined();
    const running = await store.update({
      checkedAt: '2026-08-09T12:00:01.000Z', commandId: command.commandId,
      ownerUserId: command.ownerUserId, state: 'running', stderr: '', stdout: '', truncated: false
    });
    expect(running?.outputCursor).toBe(0);
    const complete = await store.update({
      checkedAt: '2026-08-09T12:00:02.000Z', commandId: command.commandId,
      exitCode: 0, finishedAt: '2026-08-09T12:00:02.000Z', ownerUserId: command.ownerUserId,
      state: 'completed', stdout: 'done\n', truncated: false
    });
    expect(complete).toMatchObject({ outputCursor: 1, state: 'completed', stdout: 'done\n' });
    expect(await store.update({
      checkedAt: '2026-08-09T12:00:03.000Z', commandId: command.commandId,
      ownerUserId: command.ownerUserId, state: 'failed', stderr: 'late'
    })).toEqual(complete);
  });
});
