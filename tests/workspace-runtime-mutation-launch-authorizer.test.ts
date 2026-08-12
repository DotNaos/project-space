import { describe, expect, test } from 'bun:test';

import { createWorkspaceRuntimeMutationLaunchAuthorizer } from '../server/workspace-runtime-session/mutation-launch-authorizer';
import type { StoredTaskExecution } from '../server/task-execution/contracts';
import type { RunnerWorkspaceRecord } from '../src/shared/task-execution-api';

const ownerUserId = 'owner';
const environmentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const threadId = '44444444-4444-4444-8444-444444444444';
const commit = 'a'.repeat(40);
const input = {
  branch: 'issue-658-safe', commit, environmentId,
  generation: '66666666-6666-4666-8666-666666666666', manifestDigest: 'b'.repeat(64),
  mode: 'process' as const, operationId: 'launch-mutation', ownerUserId,
  profile: 'mutation' as const, runtimeVersion: '0.6.0', workspaceId,
  worktreeOwnerThreadId: threadId
};

describe('Workspace Runtime mutation launch authorizer', () => {
  test('requires the exact ready Workspace lease owned by the task thread', async () => {
    expect(await fixture()(input)).toBe(true);
    expect(await fixture({ executionState: 'completed' })(input)).toBe(false);
    expect(await fixture({ workspaceId: '77777777-7777-4777-8777-777777777777' })(input)).toBe(false);
  });
});

function fixture(options: { executionState?: StoredTaskExecution['state']; workspaceId?: string } = {}) {
  const execution: StoredTaskExecution = {
    agent: { kind: 'codex' }, createdAt: '2026-08-12T00:00:00.000Z', environmentId,
    handoff: { id: '55555555-5555-4555-8555-555555555555', revision: 1 }, id: executionId,
    ownerUserId, source: { branch: input.branch, commit, repositoryId: '42', taskId: 'task' },
    state: options.executionState ?? 'starting_agent', updatedAt: '2026-08-12T00:00:00.000Z', version: 1
  };
  const workspace: RunnerWorkspaceRecord = {
    branch: input.branch, commit, createdAt: '2026-08-12T00:00:00.000Z', executionId,
    id: options.workspaceId ?? workspaceId, kind: 'worktree', repositoryId: '42', state: 'ready',
    updatedAt: '2026-08-12T00:00:00.000Z', version: 1
  };
  return createWorkspaceRuntimeMutationLaunchAuthorizer({
    async readByExecutor(inputOwner, _agent, externalId) {
      return inputOwner === ownerUserId && externalId === threadId ? execution : undefined;
    },
    async readWorkspace(inputOwner, inputExecution) {
      return inputOwner === ownerUserId && inputExecution === executionId ? workspace : undefined;
    }
  });
}
