import { describe, expect, test } from 'bun:test';
import { parseChangelogCatalog } from '../apps/docs/lib/changelog/model';
import { withPrChangelogEntries } from '../apps/docs/lib/changelog/pr-source';

const empty = parseChangelogCatalog(
  { entries: [], schema: 'project-space.changelog/v1' },
  { schema: 'project-space.changelog-versions/v1', versions: [] },
);

describe('raw PR changelog Docs Inbox', () => {
  test('keeps an unassigned raw PR changelog visible in Unreleased', () => {
    const result = withPrChangelogEntries(
      empty,
      new Map([
        ['473.md', '---\nbump: patch\n---\n\n# Inbox item\n\nDetails.\n'],
      ]),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.catalog.entries).toEqual([
      {
        body: '# Inbox item\n\nDetails.',
        category: 'changed',
        id: 'pr-473-changelog',
        pullRequestNumber: 473,
        summary: 'Inbox item',
        testing: [],
      },
    ]);
  });

  test('fails closed on malformed or duplicate raw files', () => {
    expect(withPrChangelogEntries(
      empty,
      new Map([['bad.md', '---\nbump: none\n---\n\nText\n']]),
    ).ok).toBe(false);
    const existing = parseChangelogCatalog(
      {
        entries: [{
          body: 'Existing', category: 'changed', id: 'existing',
          pullRequestNumber: 473, summary: 'Existing', testing: ['test'],
        }],
        schema: 'project-space.changelog/v1',
      },
      { schema: 'project-space.changelog-versions/v1', versions: [] },
    );
    expect(withPrChangelogEntries(
      existing,
      new Map([['473.md', '---\nbump: patch\n---\n\nText\n']]),
    ).ok).toBe(false);
  });
});
