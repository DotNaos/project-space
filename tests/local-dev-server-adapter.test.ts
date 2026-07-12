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

function runtimeJson(directory: string) {
  return JSON.stringify({
    allowedHosts: [],
    capability: 'configured',
    checkedAt: new Date().toISOString(),
    directory,
    lastError: null,
    localPort: null,
    localUrl: null,
    operation: 'status',
    pid: null,
    publicPort: null,
    publicUrl: null,
    schemaVersion: 1,
    script: 'dev',
    startedAt: null,
    state: 'stopped',
    tailscaleIPv4: null
  });
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
});
