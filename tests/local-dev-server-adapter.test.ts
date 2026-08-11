import { describe, expect, test } from 'bun:test';

import { createLocalDevServerAdapter } from '../server/local-dev-server-adapter';
import type { ProjectBinaryRunResult } from '../server/local-project-cli-client';

const headSha = 'a'.repeat(40);
const request = {
  actor: { generation: 3, userId: 'user-a' },
  allowedHosts: [],
  expectedHeadSha: headSha,
  machineId: 'machine-1',
  operation: 'inspect' as const,
  projectId: 'connector-project:bWFjaGluZS0x:bG9jYWwtcHJvamVjdA',
  runTarget: 'dev',
  serverId: 'dev',
  worktreeId: 'wt_111111111111111111111111'
};

function binaryResult(stdout: string): ProjectBinaryRunResult {
  return { durationMs: 1, exitCode: 0, stderr: '', stdout };
}

function runtimeJson(directory: string, options: { legacy?: boolean; operation?: string } = {}) {
  const result: Record<string, unknown> = {
    allowedHosts: [],
    apis: 'external',
    capability: 'configured',
    checkedAt: new Date().toISOString(),
    data: 'remote',
    directory,
    lastError: null,
    localPort: null,
    localUrl: null,
    mode: 'managed',
    operation: options.operation ?? 'status',
    pid: null,
    portlessName: '',
    publicPort: null,
    publicUrl: null,
    repository: '/tmp/project/.git',
    schemaVersion: 2,
    secrets: 'required',
    serverId: 'project-serve-project-space-dev-test',
    serverKey: 'dev',
    script: 'dev',
    startedAt: null,
    state: 'stopped',
    tailscaleIPv4: null,
    tmuxSession: 'project-serve-project-space-dev-test'
  };
  if (options.legacy) {
    delete result.apis;
    delete result.data;
    delete result.secrets;
  }
  return JSON.stringify(result);
}

describe('local dev-server adapter identity resolution', () => {
  test('uses the freshly resolved moved worktree path and exact HEAD', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const movedPath = '/tmp/moved-worktree';
    const adapter = createLocalDevServerAdapter({
      resolveProjectPath: async (machineId, projectId) => {
        expect(machineId).toBe(request.machineId);
        expect(projectId).toBe(request.projectId);
        return '/tmp/project';
      },
      resolveWorktree: async (projectPath, worktreeId, options) => {
        expect(projectPath).toBe('/tmp/project');
        expect(worktreeId).toBe(request.worktreeId);
        expect(options.expectedHeadSha).toBe(headSha);
        return {
          detached: true,
          headSha,
          id: worktreeId,
          isBase: false,
          kind: 'external',
          locked: false,
          name: 'Moved worktree',
          path: movedPath,
          prunable: false,
          status: 'ready'
        };
      },
      runBinary: async (args, cwd) => {
        calls.push({ args, cwd });
        return binaryResult(runtimeJson(movedPath));
      }
    });

    const result = await adapter.runDevServerCommand(request);

    expect(result.state).toBe('stopped');
    expect(calls).toEqual([
      {
        args: ['serve', 'status', movedPath, '--script', 'dev', '--json'],
        cwd: movedPath
      }
    ]);
  });

  test('does not invoke the CLI when local worktree resolution fails', async () => {
    let ranBinary = false;
    const adapter = createLocalDevServerAdapter({
      resolveProjectPath: async () => '/tmp/project',
      resolveWorktree: async () => {
        throw new Error('The worktree HEAD changed before the action could start.');
      },
      runBinary: async () => {
        ranBinary = true;
        return binaryResult('');
      }
    });

    await expect(adapter.runDevServerCommand(request)).rejects.toThrow('HEAD changed');
    expect(ranBinary).toBe(false);
  });

  test('keeps an older CLI response compatible as the historical external/remote binding', async () => {
    const movedPath = '/tmp/moved-worktree';
    const adapter = createLocalDevServerAdapter({
      resolveProjectPath: async () => '/tmp/project',
      resolveWorktree: async () => ({
        detached: false, headSha, id: request.worktreeId, isBase: false, kind: 'external',
        locked: false, name: 'Moved worktree', path: movedPath, prunable: false, status: 'ready'
      }),
      runBinary: async () => binaryResult(runtimeJson(movedPath, { legacy: true }))
    });

    expect((await adapter.runDevServerCommand(request)).state).toBe('stopped');
  });

  test('opts established connector starts into the explicit external/remote binding', async () => {
    const calls: string[][] = [];
    const movedPath = '/tmp/moved-worktree';
    const adapter = createLocalDevServerAdapter({
      resolveProjectPath: async () => '/tmp/project',
      resolveWorktree: async () => ({
        detached: false, headSha, id: request.worktreeId, isBase: false, kind: 'external',
        locked: false, name: 'Moved worktree', path: movedPath, prunable: false, status: 'ready'
      }),
      runBinary: async (args) => {
        calls.push(args);
        return binaryResult(runtimeJson(movedPath, { operation: 'start' }));
      }
    });

    await adapter.runDevServerCommand({ ...request, operation: 'start' });

    expect(calls).toEqual([[
      'serve', 'dev', movedPath,
      '--apis', 'external', '--data', 'remote', '--tailnet', '--json'
    ]]);
  });
});
