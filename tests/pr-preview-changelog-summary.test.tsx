import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import * as changelogApi from '../src/shared/pr-preview-changelog-api';
import * as testTargetsApi from '../src/shared/pr-preview-changelog-test-targets';

function modalPassthrough({
  children
}: {
  children?: ReactNode;
  [key: string]: unknown;
}) {
  return createElement('div', null, children);
}

function modalRoot({
  children,
  isOpen
}: {
  children?: ReactNode;
  isOpen?: boolean;
}) {
  return isOpen
    ? createElement('div', { role: 'dialog' }, children)
    : null;
}

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/shared/pr-preview-changelog-api', () => changelogApi);
mock.module(
  '@/shared/pr-preview-changelog-test-targets',
  () => testTargetsApi
);

mock.module('@heroui/react', () => ({
  Disclosure: Object.assign(modalPassthrough, {
    Body: modalPassthrough,
    Content: modalPassthrough,
    Heading: modalPassthrough,
    Indicator: modalPassthrough,
    Trigger: modalPassthrough
  }),
  ModalBackdrop: modalPassthrough,
  ModalBody: modalPassthrough,
  ModalCloseTrigger: () => null,
  ModalContainer: modalPassthrough,
  ModalDialog: modalPassthrough,
  ModalFooter: modalPassthrough,
  ModalHeader: modalPassthrough,
  ModalHeading: modalPassthrough,
  ModalIcon: modalPassthrough,
  ModalRoot: modalRoot
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
    expect(html).not.toContain('Pull request #298');
  });

  test('consolidates testing guidance across multiple entries', () => {
    const snapshot = availableSnapshot();
    const html = renderToStaticMarkup(
      <PullRequestChangelogSummary
        expectedIdentity={identity}
        snapshot={{
          ...snapshot,
          entries: [
            ...snapshot.entries,
            {
              category: 'changed',
              id: 'pr-298-second-change',
              pullRequestNumber: 298,
              summary: 'Keep the notice calm and focused.',
              testing: [
                'Open the changelog for this pull request.',
                'Check the compact modal at a narrow width.'
              ]
            }
          ]
        }}
      />
    );

    expect(html).toContain('Keep the notice calm and focused.');
    expect(html.match(/What to test/g)).toHaveLength(1);
    expect(
      html.match(/Open the changelog for this pull request\./g)
    ).toHaveLength(1);
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
