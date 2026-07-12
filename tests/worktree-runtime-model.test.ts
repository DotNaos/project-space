import { describe, expect, test } from 'bun:test';

import {
  runtimeRowsForWorktrees,
  unmaterializedBranchesFor
} from '../src/features/project-desktop/components/worktree-runtime-model';
import type { ProjectWorktreeRecord } from '../src/shared/project-space-api';

const worktrees: ProjectWorktreeRecord[] = [
  {
    branchName: 'Feature/Case',
    detached: false,
    headSha: 'a'.repeat(40),
    id: 'wt_111111111111111111111111',
    isBase: false,
    kind: 'project-managed',
    locked: false,
    name: 'case-upper',
    path: '/connector/private/a',
    prunable: false,
    status: 'ready'
  },
  {
    branchName: 'feature/case',
    detached: false,
    headSha: 'b'.repeat(40),
    id: 'wt_222222222222222222222222',
    isBase: false,
    kind: 'project-managed',
    locked: false,
    name: 'case-lower',
    path: '/connector/private/b',
    prunable: false,
    status: 'ready'
  },
  {
    detached: true,
    headSha: 'c'.repeat(40),
    id: 'wt_333333333333333333333333',
    isBase: false,
    kind: 'codex',
    locked: false,
    name: 'Codex · a281 · ccccccc',
    path: '/connector/private/detached',
    prunable: false,
    status: 'ready'
  }
];

describe('worktree runtime model', () => {
  test('keeps case-distinct and detached worktrees as stable-ID rows', () => {
    const rows = runtimeRowsForWorktrees(worktrees);

    expect(rows.map((row) => row.worktree.id)).toEqual([
      'wt_111111111111111111111111',
      'wt_222222222222222222222222',
      'wt_333333333333333333333333'
    ]);
    expect(rows.map((row) => row.label)).toEqual([
      'Feature/Case',
      'feature/case',
      'Codex · a281 · ccccccc'
    ]);
  });

  test('keeps branch matching case-sensitive and detached-safe for creation', () => {
    expect(
      unmaterializedBranchesFor(
        ['Feature/Case', 'feature/case', 'FEATURE/CASE', 'new-branch'],
        worktrees
      )
    ).toEqual(['FEATURE/CASE', 'new-branch']);
  });
});
