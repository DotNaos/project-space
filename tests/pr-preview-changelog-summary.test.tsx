import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import * as changelogApi from '../src/shared/pr-preview-changelog-api';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/shared/pr-preview-changelog-api', () => changelogApi);

mock.module('@heroui/react', () => ({
  Chip: ({
    children,
    ...props
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('span', props, children)
}));

import {
  pullRequestChangelogDocsHref,
  pullRequestChangelogSchema,
  type PullRequestChangelogIdentity,
  type PullRequestChangelogSnapshot
} from '../src/shared/pr-preview-changelog-api';

const { PullRequestChangelogSummary } = await import(
  '../src/features/pr-preview-changelog/pull-request-changelog-summary'
);

const identity: PullRequestChangelogIdentity = {
  headSha: 'a'.repeat(40),
  pullRequestNumber: 298,
  repositoryFullName: 'DotNaos/project-space'
};

function availableSnapshot(): PullRequestChangelogSnapshot {
  return {
    ...identity,
    docsHref: pullRequestChangelogDocsHref(
      identity.pullRequestNumber
    ),
    entries: [
      {
        category: 'added',
        id: 'pr-298-changelog',
        issueNumber: 298,
        pullRequestNumber: 298,
        summary: 'Add exact-source changelog guidance.',
        testing: [
          'Open the changelog for this pull request.',
          'Verify the documented Preview behavior.'
        ]
      }
    ],
    schema: pullRequestChangelogSchema,
    state: 'available'
  };
}

describe('pull request changelog summary', () => {
  test('renders entries and the exact same-origin Docs link', () => {
    const html = renderToStaticMarkup(
      <PullRequestChangelogSummary
        expectedIdentity={identity}
        snapshot={availableSnapshot()}
      />
    );

    expect(html).toContain('Add exact-source changelog guidance.');
    expect(html).toContain('What to test');
    expect(html).toContain('/docs/changelog?pr=298');
    expect(html).toContain('1 change');
  });

  test('renders an honest missing state without fabricated guidance', () => {
    const html = renderToStaticMarkup(
      <PullRequestChangelogSummary
        snapshot={{
          ...identity,
          docsHref: pullRequestChangelogDocsHref(298),
          entries: [],
          reasonCode: 'no-entry',
          schema: pullRequestChangelogSchema,
          state: 'missing'
        }}
      />
    );

    expect(html).toContain('No changelog entry or testing guidance');
    expect(html).not.toContain('What to test');
    expect(html).toContain('/docs/changelog?pr=298');
  });

  test('hides entries and links when the expected revision contradicts the snapshot', () => {
    const snapshot = availableSnapshot();
    const html = renderToStaticMarkup(
      <PullRequestChangelogSummary
        expectedIdentity={{
          ...identity,
          headSha: 'b'.repeat(40)
        }}
        snapshot={snapshot}
      />
    );

    expect(html).toContain('does not match this pull request revision');
    expect(html).not.toContain('Add exact-source changelog guidance.');
    expect(html).not.toContain('<a');
  });

  test('rejects a non-canonical Docs link', () => {
    const snapshot = {
      ...availableSnapshot(),
      docsHref: 'https://example.com/docs/changelog?pr=298'
    };
    const html = renderToStaticMarkup(
      <PullRequestChangelogSummary snapshot={snapshot} />
    );

    expect(html).toContain('does not match this pull request revision');
    expect(html).not.toContain('example.com');
    expect(html).not.toContain('<a');
  });

  test('renders repository text as escaped content', () => {
    const snapshot = availableSnapshot();
    const html = renderToStaticMarkup(
      <PullRequestChangelogSummary
        snapshot={{
          ...snapshot,
          entries: [
            {
              ...snapshot.entries[0],
              summary: '<script>alert(1)</script>',
              testing: ['<img src=x onerror=alert(1)>']
            }
          ]
        }}
      />
    );

    expect(html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(html).toContain(
      '&lt;img src=x onerror=alert(1)&gt;'
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });
});
