import { describe, expect, test } from 'bun:test';
import { createLocalWorktreeActionAdapter } from '../server/local-worktree-action-adapter';
import type { ProjectBinaryRunResult } from '../server/local-project-cli-client';

const request = {
  actor: { generation: 3, userId: 'user-a' },
  declarationDigest: 'b'.repeat(64),
  expectedHeadSha: 'a'.repeat(40),
  machineId: 'machine-1',
  operation: 'setup.run' as const,
  projectId: 'project-1',
  repositoryFullName: 'DotNaos/project-space',
  setupStepId: 'install',
  worktreeId: 'wt_111111111111111111111111'
};
function result(stdout: string): ProjectBinaryRunResult {
  return { durationMs: 1, exitCode: 0, stderr: '', stdout };
}

describe('local worktree action adapter', () => {
  test('passes the exact setup fingerprint into the same trusted prepare operation', async () => {
    const calls: string[][] = [];
    const adapter = createLocalWorktreeActionAdapter(
      async (args) => {
        calls.push(args);
        return result(
          JSON.stringify({
            capability: 'configured',
            checkedAt: new Date().toISOString(),
            directory: '/tmp/project',
            lastError: null,
            operation: 'prepare',
            schemaVersion: 1,
            steps: [
              {
                capability: 'configured',
                checkedAt: new Date().toISOString(),
                commit: 'a'.repeat(40),
                declarationDigest: 'b'.repeat(64),
                directory: '/tmp/project',
                finishedAt: null,
                lastError: null,
                operation: 'prepare',
                schemaVersion: 1,
                startedAt: null,
                state: 'required',
                stepId: 'install'
              }
            ]
          })
        );
      },
      {
        resolveProjectPath: async () => '/tmp/project',
        resolveWorktree: async () => ({
          branchName: 'feature',
          detached: false,
          headSha: 'a'.repeat(40),
          id: request.worktreeId,
          isBase: false,
          kind: 'project-managed',
          locked: false,
          name: 'feature',
          path: '/tmp/project',
          prunable: false,
          status: 'ready'
        })
      }
    );
    const mapped = await adapter.runWorktreeAction(request);
    expect(mapped).toMatchObject({
      capability: 'configured',
      operation: 'setup.run',
      steps: [{ commitSha: 'a'.repeat(40), declarationDigest: 'b'.repeat(64) }]
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'prepare',
      '/tmp/project',
      '--step',
      'install',
      '--expect-commit',
      'a'.repeat(40),
      '--expect-declaration-digest',
      'b'.repeat(64),
      '--format',
      'json'
    ]);
  });
});
