import { describe, expect, test } from 'bun:test';

import { createConfiguredCodexMachineTasksService } from '../server/codex-machine-tasks/configured-runtime';
import type { WorkspaceRuntimeCodexBridge } from '../server/codex-machine-tasks/workspace-runtime';
import {
  connector,
  memoryStore,
  request,
  threadId
} from './fixtures/codex-machine-tasks-service';

describe('configured Codex machine-task runtime', () => {
  test('reconciles an uncertain initial handoff exactly once after a runtime restart', async () => {
    const starts: Array<{ durableOperations: boolean; reconcile: boolean }> = [];
    let readReconciliationCount = 0;
    const bridge = {
      inventory: async () => ({
        computeInventory: {
          connectors: [], environmentDefinitions: [], environments: [], hosts: [],
          platforms: [], violations: []
        },
        connectors: [connector()],
        physicalMachines: [{ connectorIds: ['connector-local'], id: 'physical-local', name: 'Mac' }],
        runtimeStatuses: new Map()
      }),
      generationFor: () => 7,
      durableGenerationFor: () => true,
      issue: undefined,
      plan: async () => ({
        plan: {
          environment: { id: 'environment-local', name: 'Workspace Runtime' },
          workspace: {
            branch: 'issue-262-build-codex-machine-task-core-and-cli',
            commit: 'a'.repeat(40),
            id: 'workspace-local'
          },
          worktree: {
            branch: 'issue-262-build-codex-machine-task-core-and-cli',
            id: 'worktree-local'
          }
        },
        state: 'ready' as const
      }),
      sessions: {} as never,
      start: async (input: { durableOperations: boolean; reconcile: boolean }) => {
        starts.push(input);
        if (!input.reconcile) {
          return { generation: 7, result: { state: 'uncertain' as const } };
        }
        readReconciliationCount += 1;
        return {
          generation: 7,
          result: {
            handoff: { state: 'accepted' as const, turnId: 'turn-reconciled' },
            state: 'confirmed' as const,
            threadId,
            workspace: {
              branch: 'issue-262-build-codex-machine-task-core-and-cli',
              commit: 'a'.repeat(40),
              id: 'workspace-local',
              worktree: { branch: 'issue-262-build-codex-machine-task-core-and-cli', id: 'worktree-local' }
            },
            worktreeId: 'worktree-local'
          }
        };
      }
    } as unknown as WorkspaceRuntimeCodexBridge;
    const tasks = createConfiguredCodexMachineTasksService({
      bridge,
      issue: async () => ({
        branch: 'issue-262-build-codex-machine-task-core-and-cli',
        commit: 'a'.repeat(40),
        issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
        repository: { id: 'R_test', nameWithOwner: 'DotNaos/project-space' }
      }),
      store: memoryStore(),
      taskUrl: (machineId, id) => `https://projects.example/codex/machines/${machineId}/threads/${id}`
    });

    const actor = { userId: 'user-owner', reportingTask: { role: 'project-manager' as const, threadId } };
    const first = await tasks.start(actor, request);
    const second = await tasks.start(actor, request);

    expect(first.state).toBe('uncertain');
    expect(second).toMatchObject({
      state: 'confirmed',
      task: { handoff: { state: 'accepted', turnId: 'turn-reconciled' } }
    });
    expect(starts.map(({ durableOperations, reconcile }) => ({ durableOperations, reconcile }))).toEqual([
      { durableOperations: true, reconcile: false },
      { durableOperations: true, reconcile: true }
    ]);
    expect(readReconciliationCount).toBe(1);
  });
});
