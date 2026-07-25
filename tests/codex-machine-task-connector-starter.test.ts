import { describe, expect, test } from 'bun:test';

import { createLocalCodexMachineTaskStarter } from '../server/codex-machine-tasks/connector-starter';

const threadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const request = {
  branch: 'issue-262-machine-tasks',
  commit: 'a'.repeat(40),
  initialPrompt: 'Implement issue 262.',
  issueNumber: 262,
  issueUrl: 'https://github.com/DotNaos/project-space/issues/262',
  machineId: 'connector-local',
  operationId: 'start-262',
  physicalMachineId: 'physical-local',
  projectId: 'github:R_repo',
  repositoryId: 'R_repo',
  repositoryNameWithOwner: 'DotNaos/project-space'
};

describe('Codex machine-task connector starter', () => {
  test('materializes, starts persistent thread, claims worktree, and begins the issue turn', async () => {
    const calls: unknown[] = [];
    const starter = createLocalCodexMachineTaskStarter({
      operationSnapshot() {
        return [];
      },
      async readThread() {
        calls.push({ kind: 'read' });
        return { thread: { id: threadId, status: { type: 'idle' }, turns: [] } };
      },
      async startThread(input: unknown) {
        calls.push({ kind: 'thread', input });
        return { thread: { id: threadId } };
      },
      async startTurn(input: unknown) {
        calls.push({ kind: 'turn', input });
        return { turn: { id: 'turn-one' } };
      }
    } as never, {
      loadWorktrees: async () => [{
        branchName: request.branch,
        detached: false,
        headSha: request.commit,
        id: 'wt_abcdef0123456789abcdef01',
        isBase: false,
        kind: 'project-managed',
        locked: false,
        name: request.branch,
        path: '/projects/.worktrees/project-space/issue-262-machine-tasks',
        prunable: false,
        status: 'ready'
      }],
      runProject: async (args, cwd, options) => {
        calls.push({ args, cwd, environment: options.environment, kind: 'claim' });
        return {
          durationMs: 1,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            branch: request.branch,
            ownerThreadId: threadId,
            path: '/projects/.worktrees/project-space/issue-262-machine-tasks',
            status: 'claimed'
          })
        };
      },
      worktreeAdapter: {
        async runWorktreeAction(input) {
          calls.push({ input, kind: 'materialize' });
          return {
            branchName: request.branch,
            checkedAt: '2026-07-17T00:00:00.000Z',
            commitSha: request.commit,
            generation: 7,
            machineId: request.machineId,
            operation: 'materialize',
            projectId: request.projectId,
            projectPath: '/projects/project-space',
            state: 'created',
            worktreePath: '/projects/.worktrees/project-space/issue-262-machine-tasks'
          };
        }
      }
    });

    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      state: 'confirmed',
      threadId,
      worktreeId: 'wt_abcdef0123456789abcdef01'
    });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'materialize' }),
      expect.objectContaining({ kind: 'thread' }),
      expect.objectContaining({
        environment: { CODEX_THREAD_ID: threadId },
        kind: 'claim'
      }),
      expect.objectContaining({ kind: 'turn' })
    ]));
  });

  test('returns a structured worktree failure before starting Codex', async () => {
    const starter = createLocalCodexMachineTaskStarter({} as never, {
      worktreeAdapter: {
        async runWorktreeAction() {
          return {
            branchName: request.branch,
            checkedAt: '2026-07-17T00:00:00.000Z',
            commitSha: request.commit,
            generation: 7,
            machineId: request.machineId,
            operation: 'materialize',
            projectId: request.projectId,
            state: 'error'
          };
        }
      }
    });
    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      message: 'Worktree materialization failed on the selected connector.',
      state: 'worktree_failure'
    });
  });

  test('does not confirm a base checkout as an isolated worktree', async () => {
    const starter = createLocalCodexMachineTaskStarter({
      async startThread() { return { thread: { id: threadId } }; }
    } as never, {
      loadWorktrees: async () => [{
        branchName: request.branch,
        detached: false,
        headSha: request.commit,
        id: 'wt_untrusted',
        isBase: true,
        kind: 'project-managed',
        locked: false,
        name: request.branch,
        path: '/projects/.worktrees/project-space/issue-262-machine-tasks',
        prunable: false,
        status: 'ready'
      }],
      runProject: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          branch: request.branch,
          ownerThreadId: threadId,
          path: '/projects/.worktrees/project-space/issue-262-machine-tasks',
          status: 'claimed'
        })
      }),
      worktreeAdapter: {
        async runWorktreeAction() {
          return {
            branchName: request.branch,
            checkedAt: '2026-07-17T00:00:00.000Z',
            commitSha: request.commit,
            generation: 7,
            machineId: request.machineId,
            operation: 'materialize' as const,
            projectId: request.projectId,
            projectPath: '/projects/project-space',
            state: 'created' as const,
            worktreePath: '/projects/.worktrees/project-space/issue-262-machine-tasks'
          };
        }
      }
    });

    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      state: 'uncertain'
    });
  });
});
