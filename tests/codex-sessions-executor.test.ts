import { describe, expect, test } from 'bun:test';

import {
  CodexSessionsExecutor,
  type CodexSessionManager
} from '../server/codex-sessions';
import type {
  CodexSessionEventListener,
  CodexThreadListInput
} from '../server/codex-sessions/contracts';

const machineId = 'workspace-runtime:test-machine';
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';
const now = 1_720_000_000_000;

class FakeSessionManager {
  readonly calls: string[] = [];
  private readonly listeners = new Set<CodexSessionEventListener>();

  subscribe(listener: CodexSessionEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listThreads(input: CodexThreadListInput) {
    this.calls.push(input.archived ? 'list-archived' : 'list-active');
    return {
      data: input.archived ? [] : [{
        archived: false,
        cwd: '/managed/workspace',
        id: threadId,
        model: 'gpt-5.4',
        name: 'Canonical runtime task',
        status: { type: 'notLoaded' as const },
        updatedAt: 1_719_999_999
      }],
      nextCursor: null
    };
  }

  async listLoadedThreads() {
    this.calls.push('list-loaded');
    return { data: [threadId] };
  }

  async readThread(id: string, includeTurns: boolean) {
    this.calls.push(`read:${includeTurns}`);
    return {
      thread: {
        archived: false,
        cwd: '/managed/workspace',
        id,
        name: 'Canonical runtime task',
        status: { type: 'notLoaded' as const },
        turns: [{
          id: 'turn-one',
          items: [
            { id: 'agent-one', text: `sk-proj-${'a'.repeat(24)}`, type: 'agentMessage' },
            { id: 'reason-one', summary: ['private chain'], type: 'reasoning' },
            {
              aggregatedOutput: `Authorization: Bearer ${'b'.repeat(24)}`,
              command: 'printenv',
              id: 'command-one',
              type: 'commandExecution'
            }
          ],
          status: 'completed'
        }],
        updatedAt: 1_719_999_999
      }
    };
  }

  async startThread(input: { cwd: string; operationId: string }) {
    this.calls.push(`start:${input.cwd}:${input.operationId}`);
    return { thread: { ephemeral: false, id: threadId, status: { type: 'idle' as const } } };
  }

  async startTurn(input: { operationId: string; prompt: string; threadId: string }) {
    this.calls.push(`turn:${input.threadId}:${input.operationId}:${input.prompt}`);
    return { turn: { id: 'turn-initial', status: 'inProgress' } };
  }
}

function fixture() {
  const manager = new FakeSessionManager();
  const executor = new CodexSessionsExecutor({
    expectedGeneration: 4,
    expectedMachineId: machineId,
    machineName: 'Workspace Runtime',
    manager: manager as unknown as CodexSessionManager,
    now: () => now
  });
  return { executor, manager };
}

describe('canonical Codex session executor', () => {
  test('lists sessions through the Workspace Runtime without Connector wire state', async () => {
    const { executor, manager } = fixture();
    const result = await executor.executeBound('list', {
      includeArchived: true,
      machineId
    }, 4);

    expect(result).toMatchObject({
      operation: 'list',
      result: {
        machine: {
          id: machineId,
          name: 'Workspace Runtime',
          online: true,
          supportsModelSelection: true,
          supportsModelSettings: true
        },
        sessions: [{ id: threadId, loadedByProjectSpace: true }]
      }
    });
    expect(manager.calls).toEqual(['list-active', 'list-archived', 'list-loaded']);
    executor.close();
  });

  test('keeps reasoning, command output, and credentials out of read results', async () => {
    const { executor } = fixture();
    const result = await executor.executeBound('read', { machineId, threadId }, 4);
    const encoded = JSON.stringify(result);

    expect(encoded).not.toContain('sk-proj-');
    expect(encoded).not.toContain('Authorization: Bearer');
    expect(encoded).not.toContain('private chain');
    expect(result).toMatchObject({
      operation: 'read',
      result: { openedReadOnly: true, session: { id: threadId } }
    });
    executor.close();
  });

  test('starts a persistent task in the exact requested worktree', async () => {
    const { executor, manager } = fixture();
    const result = await executor.executeBound('start', {
      cwd: '/managed/worktrees/issue-479',
      machineId,
      operationId: 'codex-ui:start:test-0001'
    }, 4);

    expect(result).toEqual({
      operation: 'start',
      result: { machineId, threadId }
    });
    expect(manager.calls).toEqual([
      'start:/managed/worktrees/issue-479:codex-ui:start:test-0001'
    ]);
    executor.close();
  });

  test('accepts the complete issue handoff only after the initial turn is accepted', async () => {
    const { executor, manager } = fixture();
    const result = await executor.executeBound('start', {
      cwd: '/managed/worktrees/issue-763',
      handoff: {
        branch: 'issue-763-dispatch',
        commit: 'a'.repeat(40),
        environmentId: '11111111-1111-4111-8111-111111111111',
        issue: { number: 763, url: 'https://github.com/DotNaos/project-space/issues/763' },
        repository: { id: 'R_project-space', nameWithOwner: 'DotNaos/project-space' },
        workspaceId: 'ws_0123456789abcdef01234567',
        worktreeId: 'worktree-763'
      },
      machineId,
      operationId: 'codex-ui:start:handoff-0001'
    }, 4);

    expect(result).toEqual({
      operation: 'start',
      result: { initialTurnId: 'turn-initial', machineId, threadId }
    });
    expect(manager.calls).toHaveLength(2);
    expect(manager.calls[1]).toContain('Work on GitHub issue #763');
    expect(manager.calls[1]).toContain('Branch: issue-763-dispatch');
    executor.close();
  });
});
