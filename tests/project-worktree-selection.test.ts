import { describe, expect, test } from 'bun:test';

import {
  selectedProjectWorktree,
  selectedWorktreeExplorerPath
} from '../src/features/project-desktop/components/project-worktree-selection';
import type { ProjectWorktreeRecord } from '../src/shared/project-space-api';

function worktree(
  id: string,
  status: ProjectWorktreeRecord['status'],
  isBase = false
): ProjectWorktreeRecord {
  return {
    branchName: isBase ? 'main' : 'topic',
    detached: false,
    headSha: 'a'.repeat(40),
    id,
    isBase,
    kind: 'project-managed',
    locked: status === 'locked',
    name: isBase ? 'main' : 'topic',
    path: `/projects/${id}`,
    prunable: status === 'prunable',
    status
  };
}

describe('worktree selection activation', () => {
  test('selects a ready opaque ID for both Git and file inspection', () => {
    const main = worktree('wt_111111111111111111111111', 'ready', true);
    const topic = worktree('wt_222222222222222222222222', 'ready');
    const selected = selectedProjectWorktree(
      [main, topic],
      { kind: 'worktree', worktreeId: topic.id }
    );

    expect(selected).toBe(topic);
    expect(selectedWorktreeExplorerPath(selected)).toBe(topic.path);
  });

  test('does not activate a locked, missing, broken, or unknown worktree', () => {
    for (const status of ['locked', 'missing', 'broken', 'prunable'] as const) {
      expect(selectedWorktreeExplorerPath(worktree(`wt_${status.padEnd(24, '0')}`, status))).toBe('');
    }
    expect(
      selectedProjectWorktree(
        [worktree('wt_111111111111111111111111', 'ready', true)],
        { kind: 'worktree', worktreeId: 'wt_999999999999999999999999' }
      )
    ).toBeUndefined();
  });
});
