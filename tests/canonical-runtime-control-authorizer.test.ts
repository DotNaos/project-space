import { describe, expect, test } from 'bun:test';

import { createCanonicalRuntimeControlAuthorizer } from '../server/canonical-runtime-control/mutation-authorizer';
import type { StoredTaskExecution } from '../server/task-execution/contracts';
import type { RunnerWorkspaceRecord } from '../src/shared/task-execution-api';

const ownerUserId = 'owner';
const environmentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const commit = 'a'.repeat(40);
const target = {
  branch: 'issue-658', commit, environmentId,
  generation: '44444444-4444-4444-8444-444444444444',
  manifestDigest: 'b'.repeat(64), platformId: 'platform', sessionId: 'session',
  targetIdentityRevision: '7:environment', workspaceId
};
const actor = { actorId: 'flora', actorKind: 'agent' as const, ownerUserId };

describe('Canonical Runtime mutation authorizer', () => {
  test('binds Git mutations to the current target HEAD', async () => {
    const authorizer = fixture().authorizer;
    expect(await authorizer.authorize({
      actor, operation: 'git.stage', phase: 'exact',
      safeInput: { expectedHead: commit, operation: 'git.stage', scope: 'all' }, target
    })).toBe(true);
    expect(await authorizer.authorize({
      actor, operation: 'git.stage', phase: 'exact',
      safeInput: { expectedHead: 'c'.repeat(40), operation: 'git.stage', scope: 'all' }, target
    })).toBe(false);
  });

  test('binds task activation to the exact ready execution and Workspace lease', async () => {
    const { authorizer } = fixture();
    const input = {
      actor, operation: 'task.start' as const, phase: 'exact' as const,
      safeInput: { operation: 'task.start' as const, taskExecutionId: executionId, workspaceLeaseId: workspaceId },
      target
    };
    expect(await authorizer.authorize(input)).toBe(true);
    expect(await fixture({ workspace: { state: 'uncertain' } }).authorizer.authorize(input)).toBe(false);
    expect(await fixture({ execution: { environmentId: '99999999-9999-4999-8999-999999999999' } })
      .authorizer.authorize(input)).toBe(false);
    expect(await fixture({ execution: { state: 'completed' } }).authorizer.authorize(input)).toBe(false);
  });
});

function fixture(overrides: {
  execution?: Partial<StoredTaskExecution>;
  workspace?: Partial<RunnerWorkspaceRecord>;
} = {}) {
  const execution: StoredTaskExecution = {
    agent: { kind: 'codex' }, createdAt: '2026-08-12T00:00:00.000Z', environmentId,
    handoff: { id: '55555555-5555-4555-8555-555555555555', revision: 1 }, id: executionId,
    ownerUserId, source: { branch: target.branch, commit, repositoryId: 'repository', taskId: 'task' },
    state: 'starting_agent', updatedAt: '2026-08-12T00:00:00.000Z', version: 1,
    ...overrides.execution
  };
  const workspace: RunnerWorkspaceRecord = {
    branch: target.branch, commit, createdAt: '2026-08-12T00:00:00.000Z', executionId,
    id: workspaceId, kind: 'worktree', repositoryId: 'repository', state: 'ready',
    updatedAt: '2026-08-12T00:00:00.000Z', version: 1,
    ...overrides.workspace
  };
  return {
    authorizer: createCanonicalRuntimeControlAuthorizer({
      taskExecutions: {
        async read(inputOwner, inputExecution) {
          return inputOwner === ownerUserId && inputExecution === executionId ? execution : undefined;
        },
        async readWorkspace(inputOwner, inputExecution) {
          return inputOwner === ownerUserId && inputExecution === executionId ? workspace : undefined;
        }
      }
    })
  };
}
