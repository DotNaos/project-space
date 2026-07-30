import { describe, expect, test } from 'bun:test';

import { prototypeReviewChangelogIdentity } from '../src/features/pr-preview-review/prototype-review-changelog';
import type { PrototypeReviewLocalContext } from '../src/shared/prototype-review-local-api';

const localContext: PrototypeReviewLocalContext = {
  checkedAt: '2026-07-28T10:00:00.000Z',
  checkout: {
    headSha: 'b'.repeat(40),
    repositoryFullName: 'DotNaos/project-space',
    state: 'available'
  },
  codex: { reason: 'codex-unavailable', state: 'unavailable' }
};

describe('prototype review changelog identity', () => {
  test('uses the local checkout without requiring Codex or a PR surface response', () => {
    expect(prototypeReviewChangelogIdentity({
      localContext,
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/project-space'
    })).toEqual({
      headSha: 'b'.repeat(40),
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/project-space'
    });
  });

  test('rejects a local checkout from another repository', () => {
    expect(prototypeReviewChangelogIdentity({
      localContext,
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/other'
    })).toBeUndefined();
  });

  test('uses the verified identity embedded in the PR Preview build', () => {
    const previewBuildIdentity = {
      headSha: 'c'.repeat(40),
      pullRequestNumber: 411,
      repositoryFullName: 'DotNaos/project-space'
    };
    expect(prototypeReviewChangelogIdentity({
      expectedIdentity: previewBuildIdentity,
      previewBuildIdentity,
      pullRequestNumber: 411,
      repositoryFullName: 'DotNaos/project-space'
    })).toEqual(previewBuildIdentity);
  });

  test('rejects a Preview build from another revision', () => {
    expect(prototypeReviewChangelogIdentity({
      expectedIdentity: {
        headSha: 'd'.repeat(40),
        pullRequestNumber: 411,
        repositoryFullName: 'DotNaos/project-space'
      },
      previewBuildIdentity: {
        headSha: 'c'.repeat(40),
        pullRequestNumber: 411,
        repositoryFullName: 'DotNaos/project-space'
      },
      pullRequestNumber: 411,
      repositoryFullName: 'DotNaos/project-space'
    })).toBeUndefined();
  });
});
