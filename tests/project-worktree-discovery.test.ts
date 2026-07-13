import { describe, expect, test } from 'bun:test';

import {
  discoverProjectWorktrees,
  reconcileProjectWorktreeDiscovery
} from '../server/project-worktree-discovery';
import type { ProjectWorktreeRecord } from '../src/shared/project-space-api';

function worktree(index: number): ProjectWorktreeRecord {
  const suffix = index.toString(16).padStart(24, '0');
  return {
    branchName: index === 0 ? 'main' : `worktree-${index}`,
    detached: false,
    headSha: index.toString(16).padStart(40, '0'),
    id: `wt_${suffix}`,
    isBase: index === 0,
    kind: 'project-managed',
    locked: false,
    name: index === 0 ? 'main' : `worktree-${index}`,
    path:
      index === 0
        ? '/Users/oli/projects/project-space'
        : `/Users/oli/projects/.worktrees/project-space/worktree-${index}`,
    prunable: false,
    status: 'ready'
  };
}

describe('authoritative project worktree discovery', () => {
  test('reports the same ready worktrees that a valid checkout proves', async () => {
    const machinesEvidence = Array.from({ length: 43 }, (_, index) => worktree(index));

    const result = await discoverProjectWorktrees({
      projectPath: '/Users/oli/projects/project-space',
      scan: async () => machinesEvidence
    });

    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('Expected ready discovery evidence.');
    expect(result.worktrees).toHaveLength(43);
    expect(result.worktrees).toEqual(machinesEvidence);
  });

  test('requires a successful authoritative scan before proving empty', async () => {
    const result = await discoverProjectWorktrees({
      projectPath: '/Users/oli/projects/project-space',
      scan: async () => []
    });

    expect(result).toMatchObject({
      evidence: {
        projectPath: '/Users/oli/projects/project-space',
        source: 'git-worktree-list'
      },
      state: 'proven-empty',
      worktrees: []
    });
  });

  test('blocks when Git discovery fails instead of claiming zero worktrees', async () => {
    const result = await discoverProjectWorktrees({
      projectPath: '/Users/oli/projects/project-space',
      scan: async () => {
        throw new Error('connector timed out');
      }
    });

    expect(result).toMatchObject({
      message: 'connector timed out',
      reason: 'scan-failed',
      state: 'blocked'
    });
    expect('worktrees' in result).toBe(false);
  });

  test('blocks immediately when the connector requires the versioned worktree contract', async () => {
    const result = await discoverProjectWorktrees({
      projectPath: '/Users/oli/projects/project-space',
      scan: async () => {
        throw new Error(
          'The connector on os-macbook does not support this action yet. Update or restart the Project Space connector on that machine.'
        );
      }
    });

    expect(result).toMatchObject({
      reason: 'connector-update-required',
      state: 'blocked'
    });
  });

  test('makes proven empty impossible when checkout evidence already exists', async () => {
    const empty = await discoverProjectWorktrees({
      projectPath: '/Users/oli/projects/project-space',
      scan: async () => []
    });

    expect(reconcileProjectWorktreeDiscovery(empty, true)).toMatchObject({
      reason: 'source-disagreement',
      state: 'blocked'
    });
    expect(reconcileProjectWorktreeDiscovery(empty, false).state).toBe('proven-empty');
  });
});
