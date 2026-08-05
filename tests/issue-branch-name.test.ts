import { describe, expect, test } from 'bun:test';

import { issueBranchName } from '../src/shared/issue-branch-name';

describe('issueBranchName', () => {
  test('uses one bounded branch name for long issue titles', () => {
    expect(issueBranchName(
      445,
      'Show the current project and Tasks page in the browser tab title'
    )).toBe('issue-445-show-the-current-project-and-tasks-page-in-the-b');
  });

  test('falls back to the issue number when the title has no slug characters', () => {
    expect(issueBranchName(12, '---')).toBe('issue-12');
  });
});
