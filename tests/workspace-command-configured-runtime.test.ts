import { describe, expect, test } from 'bun:test';
import { dispatchRetiredWorkspaceCommand } from '../server/workspace-command/configured-runtime';

describe('configured workspace command retirement', () => {
  test('makes a historical Connector command terminal without opening a command channel', async () => {
    const result = await dispatchRetiredWorkspaceCommand('status', {
      allowNetwork: false,
      commandId: '11111111-1111-4111-8111-111111111111',
      commandSha256: 'a'.repeat(64),
      environmentId: '22222222-2222-4222-8222-222222222222',
      executionId: '33333333-3333-4333-8333-333333333333',
      machineId: 'connector-1',
      maxOutputBytes: 4_096,
      operation: 'status',
      projectId: 'github:480',
      repositoryWritable: false,
      timeoutSeconds: 30,
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceWritable: false,
      worktreeId: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa'
    }, { generation: 7, userId: 'user-1' });

    expect(result).toMatchObject({
      generation: 7,
      machineId: 'connector-1',
      operation: 'status',
      state: 'unsupported'
    });
  });
});
