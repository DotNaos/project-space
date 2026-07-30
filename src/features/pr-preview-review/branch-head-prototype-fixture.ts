import type { GitHubBranchComparisonResult } from '../../shared/project-space-api';

const mergeBase = '1'.repeat(40);
const headSha = 'a'.repeat(40);
const headParent = 'b'.repeat(40);
const defaultSha = 'd'.repeat(40);
const defaultParent = 'e'.repeat(40);
const checkedAt = '2026-07-30T09:00:00.000Z';

export const branchHeadPrototypeCopy = {
  branch: 'issue-408-show-a-focused-git-graph-around-the-linked-branch-head',
  issueTitle: 'Show a focused Git graph around the linked branch head'
} as const;

export const branchHeadPrototypeComparison: GitHubBranchComparisonResult = {
  aheadBy: 2,
  behindBy: 2,
  checkedAt,
  commits: [
    commit(headSha, [headParent], 'Show the verified branch head graph'),
    commit(defaultSha, [defaultParent], 'Keep default branch checks current'),
    commit(headParent, [mergeBase], 'Add bounded comparison states'),
    commit(defaultParent, [mergeBase], 'Harden preview deployment status'),
    commit(mergeBase, [], 'Share issue development context')
  ],
  defaultBranch: { name: 'main', sha: defaultSha },
  freshness: 'current',
  head: {
    name: branchHeadPrototypeCopy.branch,
    sha: headSha
  },
  mergeBaseIncluded: true,
  mergeBaseSha: mergeBase,
  state: 'diverged',
  status: 'connected',
  truncated: true
};

function commit(hash: string, parents: string[], subject: string) {
  return {
    author: 'DotNaos',
    date: checkedAt,
    hash,
    parents,
    refs: [],
    subject
  };
}
