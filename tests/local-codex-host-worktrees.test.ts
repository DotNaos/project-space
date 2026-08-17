import { describe, expect, test } from 'bun:test';

import { createLocalCodexHostWorktreeLoader } from '../server/local-codex-host-worktrees';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

describe('local Codex host worktrees', () => {
  test('publishes only ready Project-managed worktrees with their task identity', async () => {
    const backend = {
      async loadProjectDiscovery() {
        return {
          groups: [],
          projects: [{
            github: { fullName: 'DotNaos/project-space' },
            id: 'project-space',
            machineId: 'machine-a',
            rootPath: '/projects/project-space'
          }],
          rootItems: [],
          rootPath: '/projects',
          structureViolations: []
        };
      },
      async loadProjectWorktrees() {
        return [{
          branchName: 'main',
          detached: false,
          id: 'main',
          isBase: true,
          kind: 'project-managed' as const,
          locked: false,
          name: 'main',
          path: '/projects/project-space',
          prunable: false,
          status: 'ready' as const
        }, {
          branchName: 'issue-763-task-start',
          detached: false,
          id: 'issue-763',
          isBase: false,
          kind: 'project-managed' as const,
          locked: false,
          name: 'issue-763-task-start',
          path: '/projects/.worktrees/project-space/issue-763-task-start',
          prunable: false,
          status: 'ready' as const
        }, {
          branchName: 'external-task',
          detached: false,
          id: 'external',
          isBase: false,
          kind: 'external' as const,
          locked: false,
          name: 'external-task',
          path: '/tmp/external-task',
          prunable: false,
          status: 'ready' as const
        }];
      }
    } as unknown as Pick<ProjectSpaceBackend, 'loadProjectDiscovery' | 'loadProjectWorktrees'>;
    const load = createLocalCodexHostWorktreeLoader(
      backend,
      'machine-a',
      async (path) => ({
        issueNumber: path.includes('issue-763') ? 763 : undefined,
        managed: path.includes('issue-763')
      })
    );

    expect(await load()).toEqual([{
      branch: 'issue-763-task-start',
      issueNumber: 763,
      label: 'issue-763-task-start',
      path: '/projects/.worktrees/project-space/issue-763-task-start',
      repository: 'DotNaos/project-space',
      threadCount: 0
    }]);
  });
});
