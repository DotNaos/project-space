import { describe, expect, mock, test } from 'bun:test';

const {
  releasedChangelogHref,
  releasedChangelogHrefFromSources
} = await import(
  '../src/features/pr-preview-changelog/changelog-links'
);

const entries = {
  entries: [
    {
      body: 'Released body.',
      category: 'added',
      id: 'released-entry',
      pullRequestNumber: 398,
      summary: 'Released summary.',
      testing: ['Verify the released behavior.']
    }
  ],
  schema: 'project-space.changelog/v1'
};

describe('released changelog links', () => {
  test('links only an exact version in a valid canonical catalog', () => {
    expect(
      releasedChangelogHrefFromSources('1.0.0-rc.1', entries, {
        schema: 'project-space.changelog-versions/v1',
        versions: [
          {
            entryIds: ['released-entry'],
            releasedAt: '2026-07-28',
            version: '1.0.0-rc.1'
          }
        ]
      })
    ).toBe(
      '/docs/changelog?version=1.0.0-rc.1'
    );
  });

  test('does not claim current release notes that are not documented', () => {
    expect(releasedChangelogHref('0.4.36')).toBeUndefined();
  });

  test('does not create a link from unknown, invalid, or malformed metadata', () => {
    expect(
      releasedChangelogHrefFromSources('2.0.0', entries, {
        schema: 'project-space.changelog-versions/v1',
        versions: []
      })
    ).toBeUndefined();
    expect(
      releasedChangelogHrefFromSources('1.0.0', entries, {
        schema: 'project-space.changelog-versions/v1',
        versions: [
          {
            entryIds: ['unknown-entry'],
            releasedAt: '2026-07-28',
            version: '1.0.0'
          }
        ]
      })
    ).toBeUndefined();
    expect(releasedChangelogHref('unknown')).toBeUndefined();
    expect(releasedChangelogHref('v0.4.36')).toBeUndefined();
    expect(releasedChangelogHref('0.4')).toBeUndefined();
    expect(
      releasedChangelogHref('0.4.36&pr=298')
    ).toBeUndefined();
  });
});
