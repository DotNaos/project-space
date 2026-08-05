import { describe, expect, test } from 'bun:test';
import type {
  GitHubBranchRecord,
  GitHubPullRequestRecord,
  ProjectWorktreeRecord
} from '../src/shared/project-space-api';
import {
  filterRepositoryBranches,
  repositoryBranchViewModels
} from '../src/features/project-desktop/components/project-repository-model';

const branches: GitHubBranchRecord[] = [
  { isDefault: true, name: 'main' },
  { isDefault: false, name: 'issue-437-redesign' },
  { isDefault: false, name: 'issue-426-preview' }
];
const pullRequests: GitHubPullRequestRecord[] = [
  {
    headBranch: 'issue-437-redesign',
    isDraft: false,
    number: 439,
    state: 'open',
    title: 'Redesign Project Space',
    url: 'https://github.com/example/repo/pull/439'
  },
  {
    headBranch: 'issue-426-preview',
    isDraft: true,
    number: 427,
    state: 'open',
    title: 'Preview hub',
    url: 'https://github.com/example/repo/pull/427'
  }
];
const worktrees = [
  { branchName: 'issue-437-redesign', id: 'wt-437', path: '/worktrees/437' }
] as ProjectWorktreeRecord[];

describe('project repository model', () => {
  test('connects pull requests and checkouts to their branch', () => {
    const result = repositoryBranchViewModels({ branches, pullRequests, worktrees });
    const branch = result.find((entry) => entry.branch.name === 'issue-437-redesign');

    expect(branch?.pullRequest?.number).toBe(439);
    expect(branch?.worktrees.map((worktree) => worktree.id)).toEqual(['wt-437']);
  });

  test('filters by checkout, draft attention, and search text', () => {
    const viewModels = repositoryBranchViewModels({ branches, pullRequests, worktrees });

    expect(filterRepositoryBranches({ branches: viewModels, filter: 'checked-out', query: '' }))
      .toHaveLength(1);
    expect(filterRepositoryBranches({ branches: viewModels, filter: 'attention', query: '' })[0]
      ?.branch.name).toBe('issue-426-preview');
    expect(filterRepositoryBranches({ branches: viewModels, filter: 'all', query: '439' })[0]
      ?.branch.name).toBe('issue-437-redesign');
  });
});
