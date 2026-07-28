import { describe, expect, test } from 'bun:test';

import {
  pullRequestChangelogSnapshotFor,
  pullRequestChangelogSnapshotFromSource
} from '../src/features/pr-preview-changelog/pull-request-changelog-snapshot';

const identity = {
  headSha: 'a'.repeat(40),
  pullRequestNumber: 298,
  repositoryFullName: 'DotNaos/project-space'
};

const canonicalIdentity = {
  ...identity,
  pullRequestNumber: 361
};

const source = {
  entries: [
    {
      body: 'First body.',
      category: 'added',
      id: 'first-change',
      issueNumber: 298,
      pullRequestNumber: 298,
      summary: 'First change.',
      testing: ['Test the first change.']
    },
    {
      body: 'Second body.',
      category: 'fixed',
      id: 'second-change',
      pullRequestNumber: 298,
      summary: 'Second change.',
      testing: ['Test the second change.']
    },
    {
      body: 'Other body.',
      category: 'changed',
      id: 'other-pr',
      pullRequestNumber: 356,
      summary: 'Other pull request.',
      testing: ['Test the other pull request.']
    }
  ],
  schema: 'project-space.changelog/v1'
};

describe('pull request changelog snapshot', () => {
  test('loads the canonical exact-source entry', () => {
    const snapshot = pullRequestChangelogSnapshotFor(canonicalIdentity);

    expect(snapshot.state).toBe('available');
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      'pr-298-canonical-changelog-docs',
      'pr-298-preview-changelog-notice'
    ]);
    expect(snapshot.docsHref).toBe('/docs/changelog?pr=361');
  });

  test('returns every entry for only the requested pull request', () => {
    const snapshot = pullRequestChangelogSnapshotFromSource(
      identity,
      source
    );

    expect(snapshot.state).toBe('available');
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      'first-change',
      'second-change'
    ]);
    expect(
      snapshot.entries.every(
        (entry) => entry.pullRequestNumber === 298
      )
    ).toBe(true);
  });

  test('reports a missing entry without broadening the filter', () => {
    const snapshot = pullRequestChangelogSnapshotFromSource(
      { ...identity, pullRequestNumber: 999 },
      source
    );

    expect(snapshot).toMatchObject({
      docsHref: '/docs/changelog?pr=999',
      entries: [],
      reasonCode: 'no-entry',
      state: 'missing'
    });
  });

  test('rejects malformed or duplicate source records', () => {
    const malformed = pullRequestChangelogSnapshotFromSource(
      identity,
      {
        ...source,
        entries: [
          source.entries[0],
          { ...source.entries[0], summary: 'Duplicate.' }
        ]
      }
    );

    expect(malformed).toMatchObject({
      entries: [],
      reasonCode: 'invalid-metadata',
      state: 'invalid'
    });
  });

  test('rejects an unverified identity', () => {
    const snapshot = pullRequestChangelogSnapshotFromSource(
      { ...identity, headSha: 'short' },
      source
    );

    expect(snapshot).toMatchObject({
      entries: [],
      reasonCode: 'invalid-metadata',
      state: 'invalid'
    });
  });
});
