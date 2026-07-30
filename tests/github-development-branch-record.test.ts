import { describe, expect, test } from 'bun:test';

import { pullRequestHeadBranchRecord } from '../server/github-branch-record';

describe('GitHub development branch records', () => {
  test('preserves the repository default marker when it is also a PR head', () => {
    expect(pullRequestHeadBranchRecord({
      branchName: 'main',
      commitSha: 'a'.repeat(40),
      current: {
        commitSha: 'b'.repeat(40),
        isDefault: true,
        linkedIssueNumbers: [408],
        name: 'main',
        url: 'https://github.com/DotNaos/project-space/tree/main'
      },
      linkedIssueNumbers: [401],
      repositoryUrl: 'https://github.com/DotNaos/project-space'
    })).toMatchObject({
      commitSha: 'a'.repeat(40),
      isDefault: true,
      linkedIssueNumbers: [401, 408],
      name: 'main'
    });
  });
});
