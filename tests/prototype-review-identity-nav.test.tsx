import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PrototypeReviewIdentityNav } from '../src/features/pr-preview-review/prototype-review-identity-nav';
import type { PullRequestTestSurfacesResult } from '../src/shared/pr-preview-test-surfaces-api';

const headSha = 'a'.repeat(40);
const search = new URLSearchParams({
  head: headSha,
  issue: '381',
  machine: 'os-mac',
  pr: '382',
  project: 'project-space',
  repository: 'DotNaos/project-space',
  thread: '019fae8d-1eae-7282-9278-b57771a9c877',
  worktree: 'issue-381'
}).toString();

function result(head = headSha): PullRequestTestSurfacesResult {
  return {
    checkedAt: '2026-07-29T10:00:00.000Z',
    feedback: { reasonCode: 'feedback-not-live', state: 'unavailable' },
    headSha: head,
    liveContext: {
      reasonCode: 'live-registration-missing',
      state: 'unavailable'
    },
    pullRequestNumber: 382,
    repositoryFullName: 'DotNaos/project-space',
    surfaces: []
  };
}

describe('prototype review identity navigation', () => {
  test('renders every exact reverse-navigation target', () => {
    const html = renderToStaticMarkup(
      <PrototypeReviewIdentityNav
        result={result()}
        search={`?${search}`}
        theme="dark"
      />
    );
    expect(html).toContain('issue #381');
    expect(html).toContain('PR #382');
    expect(html).toContain('/projects/project-space/issues/381');
    expect(html).toContain('github.com/DotNaos/project-space/pull/382');
    expect(html).toContain('/codex/machines/os-mac/threads/');
    expect(html).toContain('/projects/project-space/workspaces?worktree=issue-381');
    expect(html).toContain('/machines/os-mac');
  });

  test('keeps a mismatched head visibly stale', () => {
    const html = renderToStaticMarkup(
      <PrototypeReviewIdentityNav
        result={result('b'.repeat(40))}
        search={`?${search}`}
        theme="dark"
      />
    );
    expect(html).toContain('bg-amber-500/15');
    expect(html).toContain(headSha.slice(0, 7));
  });
});
