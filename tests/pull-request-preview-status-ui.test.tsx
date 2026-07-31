import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  Chip: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('span', props, children),
  Text: ({ as = 'span', children, ...props }: { as?: ElementType; children?: ReactNode; [key: string]: unknown }) => createElement(as, props, children)
}));

import type { GitHubPullRequestRecord } from '../src/shared/project-space-api';

const { PullRequestPreviewStatusView } = await import(
  '../src/features/project-desktop/components/pull-request-preview-status'
);

const repositoryFullName = 'DotNaos/project-space';
const headSha = 'a'.repeat(40);
const pullRequest: GitHubPullRequestRecord = {
  headSha,
  number: 263,
  state: 'open',
  title: 'Preview deployments',
  url: 'https://github.com/DotNaos/project-space/pull/263'
};

describe('pull request Preview status UI', () => {
  test('renders the current verified link', () => {
    const html = renderToStaticMarkup(<PullRequestPreviewStatusView
      inventory={{
        result: {
          checkedAt: '2026-07-22T10:00:00.000Z',
          previews: [{
            liveUrl: 'https://pr-263.projects.os-home.net/',
            liveUrlState: 'available',
            pullRequestNumber: 263,
            repositoryFullName,
            requestedSha: headSha,
            runningSha: headSha,
            state: 'ready'
          }],
          repositoryFullName,
          status: 'available'
        },
        state: 'ready'
      }}
      pullRequest={pullRequest}
      repositoryFullName={repositoryFullName}
    />);
    expect(html).toContain('Open preview');
    expect(html).toContain('https://pr-263.projects.os-home.net/');
  });

  test('renders blocked evidence without a link', () => {
    const html = renderToStaticMarkup(<PullRequestPreviewStatusView
      inventory={{ reason: 'Preview registry unavailable.', state: 'blocked', status: 'unavailable' }}
      pullRequest={pullRequest}
      repositoryFullName={repositoryFullName}
    />);
    expect(html).toContain('Preview unavailable');
    expect(html).not.toContain('<a');
  });

  test('renders a capacity block as pending rather than failed', () => {
    const html = renderToStaticMarkup(<PullRequestPreviewStatusView
      inventory={{
        result: {
          checkedAt: '2026-07-22T10:00:00.000Z',
          previews: [{
            liveUrlState: 'not-configured',
            pullRequestNumber: 263,
            repositoryFullName,
            requestedSha: headSha,
            state: 'blocked-capacity'
          }],
          repositoryFullName,
          status: 'available'
        },
        state: 'ready'
      }}
      pullRequest={pullRequest}
      repositoryFullName={repositoryFullName}
    />);
    expect(html).toContain('Waiting for capacity');
    expect(html).toContain('request remains pending');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('failed');
  });
});
