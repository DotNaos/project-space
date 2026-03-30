import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorktreeRecord,
  inferProjectNameFromGitData,
  normalizeRepoName,
  parseWorktreeListOutput
} from './project-git-metadata';

test('normalizeRepoName supports https and ssh remotes', () => {
  assert.equal(
    normalizeRepoName('https://github.com/DotNaos/project-space.git'),
    'project-space'
  );
  assert.equal(
    normalizeRepoName('git@github.com:DotNaos/figma-capture-for-chrome.git'),
    'figma-capture-for-chrome'
  );
});

test('inferProjectNameFromGitData prefers repo identity over folder names', () => {
  assert.equal(
    inferProjectNameFromGitData({
      fallbackPath: '/Users/oli/projects/project-space/project-space-worktrees-ideas',
      remoteUrl: 'https://github.com/DotNaos/project-space.git'
    }),
    'project-space'
  );
});

test('inferProjectNameFromGitData falls back to git common dir for worktrees', () => {
  assert.equal(
    inferProjectNameFromGitData({
      fallbackPath: '/Users/oli/projects/project-space/project-space-worktrees-ideas',
      gitCommonDir: '/Users/oli/projects/project-space/project-space/.git/worktrees/project-space-worktrees-ideas'
    }),
    'project-space'
  );
});

test('createWorktreeRecord prefers branch names over folder names', () => {
  const worktree = createWorktreeRecord({
    branchRef: 'refs/heads/codex/worktrees-ideas',
    isBase: false,
    path: '/Users/oli/projects/project-space/project-space-worktrees-ideas',
    status: 'ready'
  });

  assert.equal(worktree.branchName, 'codex/worktrees-ideas');
  assert.equal(worktree.name, 'codex/worktrees-ideas');
});

test('createWorktreeRecord falls back to folder name when branch is missing', () => {
  const worktree = createWorktreeRecord({
    isBase: false,
    path: '/Users/oli/projects/project-space/project-space-worktrees-ideas',
    status: 'ready'
  });

  assert.equal(worktree.branchName, undefined);
  assert.equal(worktree.name, 'project-space-worktrees-ideas');
});

test('parseWorktreeListOutput uses branch names for both base and extra worktrees', () => {
  const worktrees = parseWorktreeListOutput(
    [
      'worktree /Users/oli/projects/project-space/project-space',
      'HEAD 9712a5b98437c0f0dc9748e063eebd928bf1ac2c',
      'branch refs/heads/main',
      '',
      'worktree /Users/oli/projects/project-space/project-space-worktrees-ideas',
      'HEAD 8140e6dddd0e14c3c45b36fd2d9d0d7672d672e0',
      'branch refs/heads/codex/worktrees-ideas'
    ].join('\n'),
    '/Users/oli/projects/project-space/project-space'
  );

  assert.deepEqual(
    worktrees.map((worktree) => worktree.name),
    ['main', 'codex/worktrees-ideas']
  );
});

test('base worktree labels do not silently leak the repo name when the branch is different', () => {
  const repoName = 'figma-capture-for-chrome';
  const [baseWorktree] = parseWorktreeListOutput(
    [
      'worktree /Users/oli/projects/figma-capture-for-chrome',
      'HEAD 41277544164e5a34b2107e3939b2b2af0a14d4b6',
      'branch refs/heads/main'
    ].join('\n'),
    '/Users/oli/projects/figma-capture-for-chrome'
  );

  assert.equal(baseWorktree.name, 'main');
  assert.notEqual(baseWorktree.name, repoName);
});
