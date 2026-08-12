import { describe, expect, test } from 'bun:test';

import { createSshWorktreeAuthorizer } from '../server/ssh-control-gateway/worktree-authorizer';
import type { StoredTaskExecution } from '../server/task-execution/contracts';
import type { RunnerWorkspaceRecord } from '../src/shared/task-execution-api';

const ownerUserId = 'owner';
const environmentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const threadId = '44444444-4444-4444-8444-444444444444';
const commit = 'a'.repeat(40);
const request = {
  branch: 'issue-658-safe', commit, environmentId, operation: 'worktree.prepare.v1' as const,
  operationId: 'prepare-one', repository: 'DotNaos/project-space', workspaceId,
  worktreeOwnerThreadId: threadId
};

describe('SSH Worktree preparation authorizer', () => {
  test('binds repository, source, Environment, Workspace lease, and owner thread', async () => {
    expect(await fixture().authorize(
      { id: 'machine', kind: 'machine', ownerUserId }, request
    )).toBe(true);
    expect(await fixture({ taskId: 'github:DotNaos/other:658' }).authorize(
      { id: 'machine', kind: 'machine', ownerUserId }, request
    )).toBe(false);
    expect(await fixture({}, { state: 'ready' }).authorize(
      { id: 'machine', kind: 'machine', ownerUserId }, request
    )).toBe(false);
    expect(await fixture().authorize(
      { id: 'human', kind: 'human', ownerUserId }, request
    )).toBe(false);
  });
});

function fixture(
  source: { taskId?: string } = {},
  workspaceOverride: Partial<RunnerWorkspaceRecord> = {}
) {
  const execution: StoredTaskExecution = {
    agent: { kind: 'codex' }, createdAt: '2026-08-12T00:00:00.000Z', environmentId,
    handoff: { id: '55555555-5555-4555-8555-555555555555', revision: 1 }, id: executionId,
    ownerUserId,
    source: {
      branch: request.branch, commit, repositoryId: '42',
      taskId: source.taskId ?? 'github:DotNaos/project-space:658'
    },
    state: 'preparing_workspace', updatedAt: '2026-08-12T00:00:00.000Z', version: 1
  };
  const workspace: RunnerWorkspaceRecord = {
    branch: request.branch, commit, createdAt: '2026-08-12T00:00:00.000Z', executionId,
    id: workspaceId, kind: 'worktree', repositoryId: '42', state: 'preparing',
    updatedAt: '2026-08-12T00:00:00.000Z', version: 1,
    ...workspaceOverride
  };
  return createSshWorktreeAuthorizer({
    async readByExecutor(inputOwner, _agent, externalId) {
      return inputOwner === ownerUserId && externalId === threadId ? execution : undefined;
    },
    async readWorkspace(inputOwner, inputExecution) {
      return inputOwner === ownerUserId && inputExecution === executionId ? workspace : undefined;
    }
  });
}
