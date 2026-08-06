import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  classifyPullRequest,
  type PullRequestInventoryInput,
} from '../scripts/report-open-pr-ci';

function pullRequest(overrides: Partial<PullRequestInventoryInput> = {}) {
  return {
    files: [],
    headRefOid: 'a'.repeat(40),
    isDraft: false,
    number: 435,
    statusCheckRollup: [],
    title: 'Example',
    updatedAt: '2026-07-31T00:00:00Z',
    url: 'https://github.com/DotNaos/project-space/pull/435',
    ...overrides,
  };
}

describe('read-only open PR inventory', () => {
  test('keeps drafts neutral even when historical checks are red', () => {
    expect(
      classifyPullRequest(
        pullRequest({
          isDraft: true,
          statusCheckRollup: [{ name: 'Versioned release entry', conclusion: 'FAILURE' }],
        }), new Date('2026-07-31T12:00:00Z'),
      ).classification,
    ).toBe('neutral_draft');
  });

  test('accepts ready ordinary and release exact heads with a successful trusted check', () => {
    expect(
      classifyPullRequest(
        pullRequest({
          files: [{ path: 'apps/docs/content/docs/releases/entries/435.mdx' }],
          statusCheckRollup: [{ name: 'Release decision', conclusion: 'SUCCESS' }],
        }), new Date('2026-07-31T12:00:00Z'),
      ).classification,
    ).toBe('ready_valid');
    expect(
      classifyPullRequest(
        pullRequest({
          statusCheckRollup: [{ name: 'Versioned release entry', conclusion: 'SUCCESS' }],
        }),
        new Date('2026-07-31T12:00:00Z'),
      ),
    ).toMatchObject({
      classification: 'ready_valid',
      ownsReleaseEntry: false,
    });
    expect(classifyPullRequest(pullRequest(), new Date('2026-07-31T12:00:00Z')).classification).toBe('ready_needs_migration');
  });

  test('keeps every current Preview terminal problem visible', () => {
    const result = classifyPullRequest(
      pullRequest({
        statusCheckRollup: ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'CANCELLED'].map(
          (conclusion) => ({ workflowName: 'Deploy PR preview', name: conclusion, conclusion }),
        ),
      }),
      new Date('2026-07-31T12:00:00Z'),
    );
    expect(result.previewFailures).toHaveLength(5);
  });

  test('separates likely inactive ready PRs for an explicit owner decision', () => {
    const result = classifyPullRequest(
      pullRequest({ updatedAt: '2026-05-01T00:00:00Z' }),
      new Date('2026-07-31T12:00:00Z'),
    );
    expect(result.classification).toBe('ready_needs_owner_decision');
    expect(result.recommendedAction).toContain('owner must decide');
  });

  test('does not contain any GitHub mutation command', () => {
    const source = readFileSync('scripts/report-open-pr-ci.ts', 'utf8');
    for (const mutation of ['--method POST', '--method PATCH', 'pr close', 'pr ready', 'pr edit']) {
      expect(source).not.toContain(mutation);
    }
  });
});
