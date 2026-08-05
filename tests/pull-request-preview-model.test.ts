import { describe, expect, test } from 'bun:test';
import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  PullRequestPreviewStatusResult
} from '../src/shared/project-space-api';
import {
  issueDevelopmentPullRequest,
  pullRequestPreviewPresentation,
  shouldShowPullRequestPreview
} from '../src/features/project-desktop/components/pull-request-preview-model';

const repositoryFullName = 'DotNaos/project-space';
const currentSha = 'a'.repeat(40);
const previousSha = 'b'.repeat(40);

function pullRequest(overrides: Partial<GitHubPullRequestRecord> = {}): GitHubPullRequestRecord {
  return {
    headBranch: 'issue-263-preview',
    headSha: currentSha,
    linkedIssueNumbers: [263],
    number: 263,
    state: 'open',
    title: 'Preview deployments',
    url: 'https://github.com/DotNaos/project-space/pull/263',
    ...overrides
  };
}

function inventory(
  overrides: Partial<PullRequestPreviewStatusResult['previews'][number]> = {}
): Extract<ReturnType<typeof readyInventory>, { state: 'ready' }> {
  return readyInventory({
    currentHeadSha: currentSha,
    liveUrl: 'https://pr-263.projects.os-home.net/',
    liveUrlState: 'available',
    pullRequestNumber: 263,
    repositoryFullName,
    requestedSha: currentSha,
    runningSha: currentSha,
    state: 'ready',
    ...overrides
  });
}

function readyInventory(preview?: PullRequestPreviewStatusResult['previews'][number]) {
  return {
    result: {
      checkedAt: '2026-07-22T10:00:00.000Z',
      previews: preview ? [preview] : [],
      repositoryFullName,
      status: 'available' as const
    },
    state: 'ready' as const
  };
}

describe('pull request Preview presentation', () => {
  test('selects only an explicitly issue-linked pull request or linked branch', () => {
    const issue: GitHubIssueRecord = {
      labels: [], number: 263, state: 'open', title: 'Preview', url: 'https://example.test/263'
    };
    const branches: GitHubBranchRecord[] = [
      { isDefault: false, linkedIssueNumbers: [263], name: 'issue-263-preview' },
      { isDefault: false, linkedIssueNumbers: [264], name: 'issue-263-preview-copy' }
    ];
    const sibling = pullRequest({
      headBranch: 'issue-263-preview-copy', linkedIssueNumbers: [264], number: 264
    });
    expect(issueDevelopmentPullRequest({
      branches,
      issue,
      pullRequests: [sibling, pullRequest()]
    })?.number).toBe(263);
  });

  test('exposes a current link only when PR head, requested SHA, and running SHA match', () => {
    const current = pullRequestPreviewPresentation({
      inventory: inventory(), pullRequest: pullRequest(), repositoryFullName
    });
    expect(current).toMatchObject({
      href: 'https://pr-263.projects.os-home.net/', label: 'Ready', state: 'current'
    });

    const mismatched = pullRequestPreviewPresentation({
      inventory: inventory({ requestedSha: previousSha, runningSha: previousSha }),
      pullRequest: pullRequest(),
      repositoryFullName
    });
    expect(mismatched).toMatchObject({ label: 'Outdated preview', state: 'outdated' });
  });

  test('distinguishes a successful empty lookup from blocked and stale evidence', () => {
    const empty = pullRequestPreviewPresentation({
      inventory: readyInventory(), pullRequest: pullRequest(), repositoryFullName
    });
    expect(empty).toMatchObject({
      label: 'Waiting for automatic deployment',
      state: 'not-deployed'
    });
    expect(empty.detail).toContain('automatic Preview deployment');
    expect(empty.href).toBeUndefined();

    const blocked = pullRequestPreviewPresentation({
      inventory: { reason: 'registry offline', state: 'blocked', status: 'unavailable' },
      pullRequest: pullRequest(),
      repositoryFullName
    });
    expect(blocked).toMatchObject({ label: 'Preview unavailable' });
    expect(blocked.href).toBeUndefined();

    expect(pullRequestPreviewPresentation({
      inventory: {
        lastSafeAt: '2026-07-22T10:00:00.000Z',
        reason: 'refresh failed',
        result: inventory().result,
        state: 'stale'
      },
      pullRequest: pullRequest(),
      repositoryFullName
    })).toMatchObject({ href: 'https://pr-263.projects.os-home.net/', label: 'Last verified preview', state: 'stale' });
  });

  test('shows Preview status for every open pull request, including drafts', () => {
    expect(shouldShowPullRequestPreview(pullRequest({ isDraft: true }))).toBe(true);
    expect(shouldShowPullRequestPreview(pullRequest({ isDraft: false }))).toBe(true);
    expect(shouldShowPullRequestPreview(pullRequest({ state: 'merged' }))).toBe(false);
    expect(shouldShowPullRequestPreview()).toBe(false);
  });

  test('never exposes a Preview link for a closed PR or a SHA-less tombstone', () => {
    const removedInventory = inventory({
      currentHeadSha: undefined,
      liveUrl: undefined,
      liveUrlState: 'not-configured',
      requestedSha: undefined,
      runningSha: undefined,
      state: 'removed'
    });
    const removed = pullRequestPreviewPresentation({
      inventory: removedInventory,
      pullRequest: pullRequest({ headSha: undefined, state: 'merged' }),
      repositoryFullName
    });
    expect(removed).toMatchObject({ label: 'Removed', state: 'removed' });
    expect(removed.href).toBeUndefined();

    const closed = pullRequestPreviewPresentation({
      inventory: inventory(),
      pullRequest: pullRequest({ state: 'closed' }),
      repositoryFullName
    });
    expect(closed).toMatchObject({ label: 'Cleanup pending', state: 'cleanup' });
    expect(closed.href).toBeUndefined();
  });
});
