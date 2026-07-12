import { describe, expect, test } from 'bun:test';
import {
  registerLocalConnectorWorktreeActionExecutor,
  requestConnectorWorktreeAction
} from '../server/connector-command-hub';

describe('connector worktree action channel', () => {
  test('routes local materialization through the same signed actor boundary', async () => {
    const actors: Array<{ generation: number; userId: string }> = [];
    const unregister = registerLocalConnectorWorktreeActionExecutor('machine-local', {
      async runWorktreeAction(request) {
        actors.push(request.actor);
        if (request.operation !== 'materialize') {
          throw new Error('unexpected operation');
        }
        return {
          branchName: request.branchName,
          checkedAt: new Date().toISOString(),
          commitSha: request.commitSha,
          generation: request.actor.generation,
          machineId: request.machineId,
          operation: 'materialize',
          projectId: request.projectId,
          projectPath: '/home/oli/projects/project-space',
          state: 'created',
          worktreePath: '/home/oli/projects/.worktrees/project-space/feature/remote-dev'
        };
      }
    });
    try {
      const result = await requestConnectorWorktreeAction(
        'materialize',
        {
          branchName: 'feature/remote-dev',
          commitSha: 'a'.repeat(40),
          machineId: 'machine-local',
          operation: 'materialize',
          projectId: 'github:42',
          repositoryFullName: 'DotNaos/project-space'
        },
        { generation: 4, userId: 'user-a' }
      );
      expect(result).toMatchObject({ operation: 'materialize', state: 'created' });
      expect(actors).toEqual([{ generation: 4, userId: 'user-a' }]);
    } finally {
      unregister();
    }
  });

  test('rejects a connector result for a different approved branch', async () => {
    const unregister = registerLocalConnectorWorktreeActionExecutor('machine-mismatch', {
      async runWorktreeAction(request) {
        return {
          branchName: 'different-branch',
          checkedAt: new Date().toISOString(),
          commitSha: 'b'.repeat(40),
          generation: request.actor.generation,
          machineId: request.machineId,
          operation: 'materialize',
          projectId: request.projectId,
          state: 'created'
        };
      }
    });
    try {
      await expect(
        requestConnectorWorktreeAction(
          'materialize',
          {
            branchName: 'feature/remote-dev',
            commitSha: 'a'.repeat(40),
            machineId: 'machine-mismatch',
            operation: 'materialize',
            projectId: 'github:42',
            repositoryFullName: 'DotNaos/project-space'
          },
          { generation: 5, userId: 'user-a' }
        )
      ).rejects.toThrow('different branch');
    } finally {
      unregister();
    }
  });
});
