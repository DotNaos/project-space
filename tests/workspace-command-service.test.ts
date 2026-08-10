import { describe, expect, test } from 'bun:test';
import { MemoryTaskExecutionOperationStore } from '../server/task-execution/operation-store';
import type {
  StoredTaskExecution,
  StoredTaskHandoffRevision,
  TaskExecutionStore,
  TaskHandoffStore
} from '../server/task-execution/contracts';
import type { WorkspaceCommandConnectorResult } from '../server/workspace-command/connector-contract';
import { createWorkspaceCommandService } from '../server/workspace-command/service';
import { MemoryWorkspaceCommandStore } from '../server/workspace-command/store';

const owner = 'user-1';
const executionId = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';
const handoffId = '33333333-3333-4333-8333-333333333333';
const workspaceId = '44444444-4444-4444-8444-444444444444';

const execution: StoredTaskExecution = {
  agent: { kind: 'codex' }, connectorBinding: { connectorId: 'connector-1', generation: 7 },
  createdAt: '2026-08-09T12:00:00.000Z', environmentId,
  handoff: { id: handoffId, revision: 1 }, id: executionId, ownerUserId: owner,
  source: {
    branch: 'issue-557-safe-shell', commit: 'a'.repeat(40), repositoryId: '480',
    taskId: 'github:DotNaos/project-space:557'
  }, state: 'running', updatedAt: '2026-08-09T12:00:00.000Z', version: 5
};
const handoff: StoredTaskHandoffRevision = {
  acceptanceCriteria: [], artifacts: [], constraints: [], context: '',
  createdAt: '2026-08-09T12:00:00.000Z', createdBy: { id: owner, kind: 'human' },
  decisions: [], fingerprint: 'b'.repeat(64), handoffId, objective: 'Repair safely.',
  ownerUserId: owner, requestedMode: 'repair', requestedPermissions: {
    delivery: 'none', network: 'restricted', repository: 'read', task: 'read', workspace: 'read'
  }, revision: 1, taskId: execution.source.taskId
};

function fixture(options: { generation?: number } = {}) {
  const commands = new MemoryWorkspaceCommandStore();
  const operations = new MemoryTaskExecutionOperationStore();
  const calls: Array<{ operation: string; request: Record<string, unknown> }> = [];
  const tasks = {
    read: async (userId: string) => userId === owner ? execution : undefined,
    readWorkspace: async (userId: string) => userId === owner ? {
      branch: execution.source.branch, commit: execution.source.commit,
      createdAt: execution.createdAt, executionId, id: workspaceId, kind: 'worktree' as const,
      repositoryId: execution.source.repositoryId, state: 'ready' as const,
      target: { kind: 'project_worktree' as const, reference: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa' },
      updatedAt: execution.updatedAt, version: 1
    } : undefined
  } as unknown as TaskExecutionStore;
  const handoffs = {
    read: async (userId: string) => userId === owner ? handoff : undefined
  } as unknown as TaskHandoffStore;
  const service = createWorkspaceCommandService({
    commands,
    async dispatch(operation, request, actor) {
      calls.push({ operation, request });
      const terminal = operation === 'status';
      return {
        checkedAt: new Date().toISOString(), commandId: request.commandId,
        environmentId: request.environmentId, executionId: request.executionId,
        ...(terminal ? { exitCode: 0, finishedAt: new Date().toISOString() } : {}),
        generation: actor.generation, machineId: request.machineId, operation,
        startedAt: new Date().toISOString(), state: terminal ? 'completed' : 'running',
        stderr: '', stdout: terminal ? 'token=supersecret /Users/alice/private/file' : '',
        truncated: false, workspaceId: request.workspaceId
      } satisfies WorkspaceCommandConnectorResult;
    },
    handoffs,
    inventory: async () => ({
      checkedAt: new Date().toISOString(),
      connectors: [{
        connector: { capabilities: ['workspace.commands.v1'], installCommand: '', status: 'online' },
        id: 'connector-1', kind: 'connector', name: 'Connector', network: {}, roles: [], sourcePath: ''
      }],
      generations: new Map([['connector-1', options.generation ?? 7]]),
      snapshot: {
        connectors: [{ associatedAt: new Date().toISOString(), connectorId: 'connector-1', environmentId }],
        environments: [], hosts: [], platforms: [], violations: []
      }
    }),
    operations,
    tasks
  });
  return { calls, commands, operations, service };
}

describe('workspace command service', () => {
  test('starts once against the exact stored workspace and reconciles a lost response', async () => {
    const { calls, operations, service } = fixture();
    const request = {
      command: 'git status --short', executionId, operationId: 'workspace:start:001'
    };
    const started = await service.startWorkspace({ userId: owner }, request);
    expect(started).toMatchObject({ executionId, state: 'running', target: { kind: 'connector_workspace' } });
    expect(calls[0]).toMatchObject({
      operation: 'start',
      request: {
        allowNetwork: false, expectedHeadSha: 'a'.repeat(40), machineId: 'connector-1',
        repositoryWritable: false, workspaceWritable: false,
        worktreeId: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa'
      }
    });
    expect(calls[0]!.request).not.toHaveProperty('cwd');
    const replayed = await service.startWorkspace({ userId: owner }, request);
    expect(replayed).toMatchObject({ state: 'completed' });
    expect(calls.map(({ operation }) => operation)).toEqual(['start', 'status']);
    expect(replayed.output[0]?.stdout).toContain('[redacted]');
    expect(replayed.output[0]?.stdout).toContain('[path]');
    expect(JSON.stringify(replayed)).not.toContain('supersecret');
    expect(await operations.read(owner, request.operationId)).toMatchObject({
      result: { commandId: replayed.commandId, state: 'completed' }, state: 'completed'
    });
  });

  test('fails closed for another owner or a changed connector generation', async () => {
    const foreign = fixture();
    await expect(foreign.service.startWorkspace({ userId: 'user-2' }, {
      command: 'pwd', executionId, operationId: 'workspace:start:foreign'
    })).rejects.toThrow('runner workspace');
    const stale = fixture({ generation: 8 });
    await expect(stale.service.startWorkspace({ userId: owner }, {
      command: 'pwd', executionId, operationId: 'workspace:start:stale'
    })).rejects.toThrow('connector generation');
    expect(stale.calls).toHaveLength(0);
  });

  test('keeps output cursor based and cancels the exact command', async () => {
    const { calls, service } = fixture();
    const started = await service.startWorkspace({ userId: owner }, {
      command: 'sleep 10', executionId, operationId: 'workspace:start:cancel'
    });
    await service.cancelWorkspace({ userId: owner }, {
      commandId: started.commandId, operationId: 'workspace:cancel:001'
    });
    expect(calls.at(-1)?.operation).toBe('cancel');

    const cursorFixture = fixture();
    const cursorRequest = {
      command: 'printf done', executionId, operationId: 'workspace:start:cursor'
    };
    await cursorFixture.service.startWorkspace({ userId: owner }, cursorRequest);
    const completed = await cursorFixture.service.startWorkspace({ userId: owner }, cursorRequest);
    const empty = await cursorFixture.service.get({ userId: owner }, {
      afterCursor: completed.nextCursor, commandId: completed.commandId
    });
    expect(empty.output).toEqual([]);
  });
});
