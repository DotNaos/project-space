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
const { RuntimeBindingProvider } = await import(
  '../src/features/project-desktop/components/runtime-binding-context'
);

const externalRuntime = {
  apis: 'external' as const,
  data: 'remote' as const,
  outboundNetwork: 'enabled' as const,
  profile: 'external-remote' as const,
  secrets: 'external' as const
};

function renderWithRuntime(element: ReactNode) {
  return renderToStaticMarkup(
    <RuntimeBindingProvider runtime={externalRuntime}>{element}</RuntimeBindingProvider>
  );
}

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
    const html = renderWithRuntime(<PullRequestPreviewStatusView
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
      returnPath="/projects/project-space/issues/263"
    />);
    expect(html).toContain('Open app Preview');
    expect(html).toContain('text-emerald-300');
    expect(html).not.toContain('border-emerald-400/30');
    expect(html).toContain(
      'https://pr.projects.os-home.net/?pr=263&amp;return=%2Fprojects%2Fproject-space%2Fissues%2F263'
    );
    expect(html).toContain('pr-263.projects.os-home.net');
  });

  test('renders blocked evidence without a link', () => {
    const html = renderWithRuntime(<PullRequestPreviewStatusView
      inventory={{ reason: 'Preview registry unavailable.', state: 'blocked', status: 'unavailable' }}
      pullRequest={pullRequest}
      repositoryFullName={repositoryFullName}
    />);
    expect(html).toContain('Preview unavailable');
    expect(html).not.toContain('<a');
  });

  test('renders the automatic deployment wait state without a link', () => {
    const html = renderWithRuntime(<PullRequestPreviewStatusView
      inventory={{
        result: {
          checkedAt: '2026-07-22T10:00:00.000Z',
          previews: [],
          repositoryFullName,
          status: 'available'
        },
        state: 'ready'
      }}
      pullRequest={{ ...pullRequest, isDraft: true }}
      repositoryFullName={repositoryFullName}
    />);
    expect(html).toContain('Waiting for automatic deployment');
    expect(html).toContain('automatic Preview deployment');
    expect(html).not.toContain('<a');
  });

  test('renders a capacity block as pending rather than failed', () => {
    const html = renderWithRuntime(<PullRequestPreviewStatusView
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
