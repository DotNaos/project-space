import { describe, expect, test } from 'bun:test';

import {
  branchHeadPrototypeComparison,
  branchHeadPrototypeCopy
} from '../src/features/pr-preview-review/branch-head-prototype-fixture';

describe('branch head PR prototype', () => {
  test('provides the bounded issue development graph used by the review surface', () => {
    expect(branchHeadPrototypeCopy.branch).toContain('issue-408');
    expect(branchHeadPrototypeComparison).toMatchObject({
      aheadBy: 2,
      behindBy: 2,
      mergeBaseIncluded: true,
      state: 'diverged',
      status: 'connected',
      truncated: true
    });
    expect(branchHeadPrototypeComparison.commits).toHaveLength(5);
  });
});
