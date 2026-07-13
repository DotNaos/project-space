import { afterEach, describe, expect, test } from 'bun:test';

import { createProjectSpaceServer } from '../server/project-space-http';
import type {
  ProjectSpaceBackend,
  ProjectWorktreeRecord
} from '../src/shared/project-space-api';

const originalAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;

afterEach(() => {
  if (originalAuthDisabled === undefined) delete process.env.PROJECT_SPACE_AUTH_DISABLED;
  else process.env.PROJECT_SPACE_AUTH_DISABLED = originalAuthDisabled;
});

function readyWorktree(): ProjectWorktreeRecord {
  return {
    branchName: 'main',
    detached: false,
    headSha: 'a'.repeat(40),
    id: 'wt_111111111111111111111111',
    isBase: true,
    kind: 'project-managed',
    locked: false,
    name: 'main',
    path: '/projects/project-space',
    prunable: false,
    status: 'ready'
  };
}

function backend({
  hasCheckoutEvidence = true,
  load
}: {
  hasCheckoutEvidence?: boolean;
  load(): Promise<ProjectWorktreeRecord[]>;
}) {
  return {
    async loadProjectDiscovery() {
      return {
        groups: [],
        projects: [
          {
            gitStatus: hasCheckoutEvidence
              ? {
                  branchName: 'main',
                  changed: 0,
                  hasUnstagedChanges: false,
                  staged: 0,
                  unstaged: 0,
                  untracked: 0
                }
              : undefined,
            id: 'project-space',
            kind: 'standalone' as const,
            machineId: 'os-macbook',
            name: 'project-space',
            rootPath: '/projects/project-space'
          }
        ],
        rootItems: [],
        rootPath: '/projects',
        structureViolations: []
      };
    },
    loadProjectWorktrees: load
  } as ProjectSpaceBackend;
}

async function requestDiscovery(testBackend: ProjectSpaceBackend) {
  process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
  const server = await createProjectSpaceServer({
    backend: testBackend,
    host: '127.0.0.1',
    port: 0
  });
  try {
    const response = await fetch(
      `${server.origin}/api/projects/worktrees?projectId=project-space&machineId=os-macbook`
    );
    expect(response.status).toBe(200);
    return await response.json();
  } finally {
    await server.close();
  }
}

describe('project worktree discovery HTTP contract', () => {
  test('returns ready evidence and stable worktree records', async () => {
    expect(await requestDiscovery(backend({ load: async () => [readyWorktree()] }))).toMatchObject({
      state: 'ready',
      worktrees: [{ id: 'wt_111111111111111111111111', status: 'ready' }]
    });
  });

  test('blocks an empty scan that contradicts valid checkout evidence', async () => {
    expect(await requestDiscovery(backend({ load: async () => [] }))).toMatchObject({
      reason: 'source-disagreement',
      state: 'blocked'
    });
  });

  test('allows proven empty only without checkout evidence', async () => {
    expect(
      await requestDiscovery(backend({ hasCheckoutEvidence: false, load: async () => [] }))
    ).toMatchObject({ state: 'proven-empty', worktrees: [] });
  });

  test('returns a blocked update reason for an incompatible connector', async () => {
    expect(
      await requestDiscovery(
        backend({
          load: async () => {
            throw new Error(
              'The connector on os-macbook does not support this action yet. Update or restart the Project Space connector on that machine.'
            );
          }
        })
      )
    ).toMatchObject({ reason: 'connector-update-required', state: 'blocked' });
  });
});
