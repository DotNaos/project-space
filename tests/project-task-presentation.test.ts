import { describe, expect, test } from 'bun:test';
import { pullRequestChipPresentation } from '../src/features/project-tasks/project-task-presentation';
import type { GitHubPullRequestRecord } from '../src/shared/project-space-api';

function pullRequest(overrides: Partial<GitHubPullRequestRecord> = {}): GitHubPullRequestRecord {
  return {
    isDraft: true,
    number: 617,
    state: 'open',
    title: 'Refactor task page',
    url: 'https://github.com/DotNaos/project-space/pull/617',
    ...overrides
  };
}

describe('project task pull request chip', () => {
  test('uses neutral presentation for draft pull requests', () => {
    expect(pullRequestChipPresentation(pullRequest())).toEqual({
      className: '!bg-neutral-600',
      color: 'default',
      icon: 'draft',
      label: 'Draft PR #617'
    });
  });

  test('uses green presentation for open pull requests', () => {
    expect(pullRequestChipPresentation(pullRequest({ isDraft: false }))).toEqual({
      className: undefined,
      color: 'success',
      icon: 'open',
      label: 'Open PR #617'
    });
  });

  test('uses purple presentation for merged pull requests', () => {
    expect(pullRequestChipPresentation(pullRequest({ isDraft: false, state: 'merged' }))).toEqual({
      className: '!bg-violet-500',
      color: 'default',
      icon: 'merged',
      label: 'Merged PR #617'
    });
  });
});
