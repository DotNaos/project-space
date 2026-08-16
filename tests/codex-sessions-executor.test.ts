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
});
