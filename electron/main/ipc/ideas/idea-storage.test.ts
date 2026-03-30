import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadWorktreeIdeaIds, moveIdeaToWorktree } from './idea-storage';

test('moveIdeaToWorktree removes the idea from old worktrees and writes it to the new one', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-space-idea-storage-'));
  const worktreeA = join(root, 'worktree-a');
  const worktreeB = join(root, 'worktree-b');

  try {
    moveIdeaToWorktree({
      idea: {
        body: 'Implement the command center',
        createdAt: '2026-03-25T00:00:00.000Z',
        githubIssueNumber: 12,
        githubIssueUrl: 'https://github.com/DotNaos/project-space/issues/12',
        githubLabels: [],
        githubState: 'open',
        id: 'idea-command-center',
        iteration: 'Iteration 1',
        source: 'github',
        title: 'Worktree command center',
        updatedAt: '2026-03-25T00:00:00.000Z'
      },
      targetWorktreePath: worktreeA,
      worktreePaths: [worktreeA, worktreeB]
    });

    assert.deepEqual(loadWorktreeIdeaIds(worktreeA), ['idea-command-center']);
    assert.deepEqual(loadWorktreeIdeaIds(worktreeB), []);

    moveIdeaToWorktree({
      idea: {
        body: 'Implement the command center',
        createdAt: '2026-03-25T00:00:00.000Z',
        githubIssueNumber: 12,
        githubIssueUrl: 'https://github.com/DotNaos/project-space/issues/12',
        githubLabels: [],
        githubState: 'open',
        id: 'idea-command-center',
        iteration: 'Iteration 1',
        source: 'github',
        title: 'Worktree command center',
        updatedAt: '2026-03-25T00:00:00.000Z'
      },
      targetWorktreePath: worktreeB,
      worktreePaths: [worktreeA, worktreeB]
    });

    assert.deepEqual(loadWorktreeIdeaIds(worktreeA), []);
    assert.deepEqual(loadWorktreeIdeaIds(worktreeB), ['idea-command-center']);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('moveIdeaToWorktree also persists local drafts when they are assigned to a worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-space-idea-storage-local-'));
  const worktreeA = join(root, 'worktree-a');
  const worktreeB = join(root, 'worktree-b');

  try {
    moveIdeaToWorktree({
      idea: {
        body: 'Sketch the rough flow before publishing',
        createdAt: '2026-03-25T00:00:00.000Z',
        id: 'idea-local-draft',
        iteration: '',
        source: 'local',
        title: '',
        updatedAt: '2026-03-25T00:00:00.000Z'
      },
      targetWorktreePath: worktreeA,
      worktreePaths: [worktreeA, worktreeB]
    });

    assert.deepEqual(loadWorktreeIdeaIds(worktreeA), ['idea-local-draft']);
    assert.deepEqual(loadWorktreeIdeaIds(worktreeB), []);

    moveIdeaToWorktree({
      idea: {
        body: 'Sketch the rough flow before publishing',
        createdAt: '2026-03-25T00:00:00.000Z',
        id: 'idea-local-draft',
        iteration: '',
        source: 'local',
        title: '',
        updatedAt: '2026-03-25T00:00:00.000Z'
      },
      worktreePaths: [worktreeA, worktreeB]
    });

    assert.deepEqual(loadWorktreeIdeaIds(worktreeA), []);
    assert.deepEqual(loadWorktreeIdeaIds(worktreeB), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
