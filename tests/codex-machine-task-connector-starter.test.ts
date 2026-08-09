import { describe, expect, test } from 'bun:test';

import {
  codespaceTaskPermissionProfile,
  createLocalCodexMachineTaskStarter
} from '../server/codex-machine-tasks/connector-starter';
import { CodexAppServerRequestError } from '../server/codex-sessions/stdio-transport';
import { CodexThreadUnmaterializedError } from '../server/codex-sessions/stdio-transport';

const threadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const replacementThreadId = '019f6d4a-e84f-79aa-a290-a686d024426b';
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
const verifiedWorktree = {
  branchName: request.branch,
  detached: false,
  headSha: request.commit,
  id: 'wt_abcdef0123456789abcdef01',
  isBase: false,
  kind: 'project-managed' as const,
  locked: false,
  name: request.branch,
  path: '/projects/.worktrees/project-space/issue-262-machine-tasks',
  prunable: false,
  status: 'ready' as const
};
const verifiedDependencies = {
  loadWorktrees: async () => [verifiedWorktree],
  readWorktreeOwner: async () => undefined
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
        throw new CodexThreadUnmaterializedError();
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
      permissionProfileId: ':danger-full-access',
      readWorktreeOwner: async () => undefined,
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
      expect.objectContaining({
        input: expect.objectContaining({ permissionProfileId: ':danger-full-access' }),
        kind: 'turn'
      })
    ]));
  });

  test('uses unrestricted task turns only inside a real GitHub Codespace', () => {
    expect(codespaceTaskPermissionProfile({
      CODESPACES: 'true',
      CODESPACE_NAME: 'project-space--537-example'
    })).toBe(':danger-full-access');
    expect(codespaceTaskPermissionProfile({ CODESPACE_NAME: 'spoofed-local-name' }))
      .toBeUndefined();
    expect(codespaceTaskPermissionProfile({ CODESPACES: 'true' }))
      .toBeUndefined();
  });

  test('returns the existing task when the owned worktree already contains its prompt', async () => {
    const calls: string[] = [];
    const starter = createLocalCodexMachineTaskStarter({
      async readThread() {
        calls.push('read');
        return {
          thread: {
            cwd: verifiedWorktree.path,
            id: threadId,
            status: { type: 'active' },
            turns: [{
              id: 'turn-existing',
              items: [{
                content: [{ text: request.initialPrompt, type: 'text' }],
                type: 'userMessage'
              }]
            }]
          }
        };
      },
      async startThread() { calls.push('start-thread'); },
      async startTurn() { calls.push('start-turn'); }
    } as never, {
      ...verifiedDependencies,
      readWorktreeOwner: async () => threadId,
      worktreeAdapter: materializedWorktreeAdapter()
    });

    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      state: 'confirmed',
      threadId,
      worktreeId: verifiedWorktree.id
    });
    expect(calls).toEqual(['read']);
  });

  test('begins the issue turn on an unmaterialized thread that already owns the worktree', async () => {
    const calls: unknown[] = [];
    const starter = createLocalCodexMachineTaskStarter({
      operationSnapshot() { return []; },
      async readThread() {
        calls.push('read');
        throw new CodexThreadUnmaterializedError();
      },
      async startThread() { calls.push('start-thread'); },
      async startTurn(input: unknown) {
        calls.push({ input, kind: 'start-turn' });
        return { turn: { id: 'turn-existing-owner' } };
      }
    } as never, {
      ...verifiedDependencies,
      permissionProfileId: ':danger-full-access',
      readWorktreeOwner: async () => threadId,
      worktreeAdapter: materializedWorktreeAdapter()
    });

    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      state: 'confirmed',
      threadId,
      worktreeId: verifiedWorktree.id
    });
    expect(calls).toEqual([
      'read',
      'read',
      {
        input: expect.objectContaining({ permissionProfileId: ':danger-full-access' }),
        kind: 'start-turn'
      }
    ]);
  });

  test('safely replaces an orphaned owner before beginning the issue turn', async () => {
    const calls: unknown[] = [];
    const starter = createLocalCodexMachineTaskStarter({
      operationSnapshot() { return []; },
      async readThread(candidateThreadId: string) {
        calls.push({ candidateThreadId, kind: 'read' });
        if (candidateThreadId === threadId) throw new CodexAppServerRequestError(-32600);
        throw new CodexThreadUnmaterializedError();
      },
      async startThread(input: unknown) {
        calls.push({ input, kind: 'start-thread' });
        return { thread: { id: replacementThreadId } };
      },
      async startTurn(input: unknown) {
        calls.push({ input, kind: 'start-turn' });
        return { turn: { id: 'turn-recovered-owner' } };
      }
    } as never, {
      ...verifiedDependencies,
      permissionProfileId: ':danger-full-access',
      readWorktreeOwner: async () => threadId,
      runProject: async (args, cwd, options) => {
        calls.push({ args, cwd, environment: options.environment, kind: 'recover' });
        return {
          durationMs: 1,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            branch: request.branch,
            ownerThreadId: replacementThreadId,
            path: verifiedWorktree.path,
            status: 'recovered'
          })
        };
      },
      worktreeAdapter: materializedWorktreeAdapter()
    });

    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      state: 'confirmed',
      threadId: replacementThreadId,
      worktreeId: verifiedWorktree.id
    });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateThreadId: threadId, kind: 'read' }),
      expect.objectContaining({ kind: 'start-thread' }),
      expect.objectContaining({
        args: [
          'worktree',
          'recover',
          '--expected-owner',
          threadId,
          '--format',
          'json'
        ],
        environment: { CODEX_THREAD_ID: replacementThreadId },
        kind: 'recover'
      }),
      expect.objectContaining({
        input: expect.objectContaining({ permissionProfileId: ':danger-full-access' }),
        kind: 'start-turn'
      })
    ]));
  });

  test('fails closed when an orphaned owner cannot be recovered safely', async () => {
    const calls: string[] = [];
    const starter = createLocalCodexMachineTaskStarter({
      async readThread() {
        calls.push('read');
        throw new CodexAppServerRequestError(-32600);
      },
      async startThread() {
        calls.push('start-thread');
        return { thread: { id: replacementThreadId } };
      },
      async startTurn() { calls.push('start-turn'); }
    } as never, {
      ...verifiedDependencies,
      readWorktreeOwner: async () => threadId,
      runProject: async () => {
        calls.push('recover');
        return {
          durationMs: 1,
          exitCode: 1,
          stderr: 'recover owned worktree: unowned worktree contains changes',
          stdout: ''
        };
      },
      worktreeAdapter: materializedWorktreeAdapter()
    });

    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      message: 'The owned Project-managed worktree contains changes and was not recovered.',
      state: 'worktree_failure'
    });
    expect(calls).toEqual(['read', 'start-thread', 'recover']);
  });

  test('reports a rejected first turn after orphan recovery as a Codex failure', async () => {
    const starter = createLocalCodexMachineTaskStarter({
      operationSnapshot() { return []; },
      async readThread(candidateThreadId: string) {
        if (candidateThreadId === threadId) throw new CodexAppServerRequestError(-32600);
        throw new CodexThreadUnmaterializedError();
      },
      async startThread() {
        return { thread: { id: replacementThreadId } };
      },
      async startTurn() {
        throw new CodexAppServerRequestError(-32600);
      }
    } as never, {
      ...verifiedDependencies,
      readWorktreeOwner: async () => threadId,
      runProject: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          branch: request.branch,
          ownerThreadId: replacementThreadId,
          path: verifiedWorktree.path,
          status: 'recovered'
        })
      }),
      worktreeAdapter: materializedWorktreeAdapter()
    });

    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      message: 'Codex could not start on the selected connector. You can retry safely.',
      state: 'codex_failure'
    });
  });

  test('does not attach an owned worktree to a different existing Codex task', async () => {
    const starter = createLocalCodexMachineTaskStarter({
      async readThread() {
        return {
          thread: {
            cwd: verifiedWorktree.path,
            id: threadId,
            status: { type: 'idle' },
            turns: [{
              id: 'turn-unrelated',
              items: [{
                content: [{ text: 'A different task.', type: 'text' }],
                type: 'userMessage'
              }]
            }]
          }
        };
      }
    } as never, {
      ...verifiedDependencies,
      readWorktreeOwner: async () => threadId,
      worktreeAdapter: materializedWorktreeAdapter()
    });

    await expect(starter(request, { generation: 7, userId: 'user-owner' })).resolves.toEqual({
      message: 'The Project-managed worktree belongs to a different Codex task.',
      state: 'worktree_failure'
    });
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

  test('returns a structured worktree failure when materialization throws', async () => {
    const starter = createLocalCodexMachineTaskStarter({} as never, {
      worktreeAdapter: {
        async runWorktreeAction() {
          throw new Error('private materialization detail');
        }
      }
    });

    const result = await starter(request, { generation: 7, userId: 'user-owner' });
    expect(result).toEqual({
      message: 'Worktree materialization failed on the selected connector.',
      state: 'worktree_failure'
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  test('reports a definite Codex rejection as retryable instead of uncertain', async () => {
    const starter = createLocalCodexMachineTaskStarter({
      async startThread() { throw new CodexAppServerRequestError(-32600); }
    } as never, {
      ...verifiedDependencies,
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
      message: 'Codex could not start on the selected connector. You can retry safely.',
      state: 'codex_failure'
    });
  });

  test('reports an unverifiable isolated worktree as a deterministic failure', async () => {
    const starter = createLocalCodexMachineTaskStarter({
      async startThread() { return { thread: { id: threadId } }; }
    } as never, {
      readWorktreeOwner: async () => undefined,
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
      message: 'The isolated Project-managed worktree could not be verified.',
      state: 'worktree_failure'
    });
  });

  test('reports a failed Project worktree claim as a deterministic failure', async () => {
    const starter = createLocalCodexMachineTaskStarter({
      async startThread() { return { thread: { id: threadId } }; }
    } as never, {
      ...verifiedDependencies,
      runProject: async () => ({
        durationMs: 1,
        exitCode: 1,
        stderr: 'unsafe remote detail',
        stdout: ''
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
      message: 'The Project-managed worktree could not be claimed.',
      state: 'worktree_failure'
    });
  });

  test.each([
    [
      'CODEX_THREAD_ID is not a valid Codex thread identifier: secret-thread-value',
      'The connector returned an invalid Codex thread identity.'
    ],
    [
      'worktree belongs to Codex thread secret-owner, not the current thread secret-current',
      'The Project-managed worktree already belongs to another Codex thread.'
    ],
    [
      'Codex thread secret-current already owns worktree /secret/first',
      'The Codex thread already owns a different Project-managed worktree.'
    ],
    [
      'unowned worktree contains changes in /secret/path',
      'The unowned Project-managed worktree contains changes and was not claimed.'
    ],
    [
      'unowned worktree HEAD does not match origin/main or refs/remotes/origin/secret',
      'The unowned Project-managed worktree does not match an approved remote branch.'
    ],
    [
      'another worktree ownership operation did not finish within 10s',
      'Another Project worktree ownership operation is still active.'
    ],
    [
      'the main worktree is read-only for implementation; run project worktree prepare',
      'The connector selected the read-only main worktree instead of an isolated checkout.'
    ],
    [
      'a dedicated non-main branch is required',
      'The materialized worktree does not have a dedicated non-main branch.'
    ],
    [
      'worktree must use the project standard path /secret/path',
      'The materialized worktree is outside the Project-managed worktree root.'
    ],
    [
      'record worktree ownership: cannot write /secret/config',
      'Project could not record the worktree ownership metadata.'
    ]
  ])('reports a safe specific Project worktree claim failure for %s', async (stderr, message) => {
    const starter = createLocalCodexMachineTaskStarter({
      async startThread() { return { thread: { id: threadId } }; }
    } as never, {
      ...verifiedDependencies,
      runProject: async () => ({
        durationMs: 1,
        exitCode: 1,
        stderr,
        stdout: ''
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

    const result = await starter(request, { generation: 7, userId: 'user-owner' });
    expect(result).toEqual({ message, state: 'worktree_failure' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('reports a mismatched Project worktree claim as a deterministic failure', async () => {
    const starter = createLocalCodexMachineTaskStarter({
      async startThread() { return { thread: { id: threadId } }; }
    } as never, {
      ...verifiedDependencies,
      runProject: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          branch: request.branch,
          ownerThreadId: '019f6d33-6aad-7302-a45e-bb7a33fc399d',
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
      message: 'The Project-managed worktree claim could not be verified.',
      state: 'worktree_failure'
    });
  });
});

function materializedWorktreeAdapter() {
  return {
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
        worktreePath: verifiedWorktree.path
      };
    }
  };
}
