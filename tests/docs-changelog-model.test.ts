import { describe, expect, test } from 'bun:test';
import {
  buildChangelogView,
  parseChangelogCatalog,
  parseChangelogFilters,
  type ChangelogCatalog,
} from '../apps/docs/lib/changelog/model';

const entriesSource = {
  schema: 'project-space.changelog/v1',
  entries: [
    {
      id: 'pr-298-preview-notice',
      category: 'added',
      summary: 'Show a preview notice.',
      body: 'The preview now explains its source revision.',
      issueNumber: 298,
      prototype: {
        scenarioId: 'ready',
        surface: 'desktop-prototype',
        viewport: 'desktop',
      },
      pullRequestNumber: 298,
      testing: ['Open the preview notice.'],
    },
    {
      id: 'pr-298-docs-link',
      category: 'changed',
      summary: 'Link the exact docs.',
      body: 'The notice links to the matching docs source.',
      issueNumber: 298,
      pullRequestNumber: 298,
      testing: ['Open the full changelog.'],
    },
    {
      id: 'pr-297-release-state',
      category: 'fixed',
      summary: 'Fix the release state.',
      body: 'Published state now follows build metadata.',
      pullRequestNumber: 297,
      testing: ['Open the released application.'],
    },
    {
      id: 'pr-296-unreleased',
      category: 'added',
      summary: 'Keep pending notes visible.',
      body: 'Unassigned entries remain unreleased.',
      pullRequestNumber: 296,
      testing: ['Open the complete changelog.'],
    },
  ],
};

const versionsSource = {
  schema: 'project-space.changelog-versions/v1',
  versions: [
    {
      version: '0.4.35',
      releasedAt: '2026-07-20',
      entryIds: ['pr-297-release-state'],
    },
    {
      version: '0.4.36',
      releasedAt: '2026-07-25',
      entryIds: ['pr-298-preview-notice', 'pr-298-docs-link'],
    },
  ],
};

function catalog(): ChangelogCatalog {
  const result = parseChangelogCatalog(entriesSource, versionsSource);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.catalog;
}

describe('Docs changelog catalog', () => {
  test('groups Unreleased first and published versions newest first', () => {
    const view = buildChangelogView(catalog(), {});

    expect(view.state).toBe('ready');
    if (view.state !== 'ready') return;
    expect(view.groups.map((group) => group.label)).toEqual([
      'Unreleased',
      '0.4.36',
      '0.4.35',
    ]);
    expect(view.groups[0]?.entries.map((entry) => entry.id)).toEqual([
      'pr-296-unreleased',
    ]);
  });

  test('uses semantic-version precedence when release dates are tied', () => {
    const tiedVersions = {
      schema: 'project-space.changelog-versions/v1',
      versions: [
        {
          version: '1.0.0-rc.1',
          releasedAt: '2026-07-25',
          entryIds: ['pr-298-preview-notice'],
        },
        {
          version: '1.0.0',
          releasedAt: '2026-07-25',
          entryIds: ['pr-298-docs-link'],
        },
      ],
    };
    const parsed = parseChangelogCatalog(entriesSource, tiedVersions);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.catalog.versions.map((release) => release.version)).toEqual([
      '1.0.0',
      '1.0.0-rc.1',
    ]);
  });

  test('returns all entries for a PR, including multiple entries', () => {
    const view = buildChangelogView(catalog(), { pullRequestNumber: 298 });

    expect(view.state).toBe('ready');
    if (view.state !== 'ready') return;
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.entries.map((entry) => entry.id)).toEqual([
      'pr-298-preview-notice',
      'pr-298-docs-link',
    ]);
    expect(view.groups[0]?.entries[0]?.prototype).toEqual({
      scenarioId: 'ready',
      surface: 'desktop-prototype',
      viewport: 'desktop',
    });
  });

  test('returns complete release notes and highlights the selected PR', () => {
    const source = structuredClone(entriesSource);
    source.entries[2]!.pullRequestNumber = 297;
    const releasedTogether = structuredClone(versionsSource);
    releasedTogether.versions[1]!.entryIds.push('pr-297-release-state');
    releasedTogether.versions[0]!.entryIds = ['pr-296-unreleased'];
    const parsed = parseChangelogCatalog(source, releasedTogether);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));

    const view = buildChangelogView(parsed.catalog, {
      version: '0.4.36',
      pullRequestNumber: 298,
    });

    expect(view.state).toBe('ready');
    if (view.state !== 'ready') return;
    expect(view.groups[0]?.entries).toHaveLength(3);
    expect(view.highlightedPullRequest).toBe(298);
  });

  test('reports contradictory PR and version filters without broadening results', () => {
    const view = buildChangelogView(catalog(), {
      version: '0.4.35',
      pullRequestNumber: 298,
    });

    expect(view.state).toBe('contradictory');
    if (view.state === 'ready') return;
    expect(view.message).toContain('not part of version 0.4.35');
  });

  test('reports missing PR and version filters honestly', () => {
    const missingPr = buildChangelogView(catalog(), { pullRequestNumber: 999 });
    const missingVersion = buildChangelogView(catalog(), { version: '9.9.9' });

    expect(missingPr.state).toBe('not-found');
    expect(missingVersion.state).toBe('not-found');
  });

  test('rejects malformed and duplicate query parameters', () => {
    expect(parseChangelogFilters({ pr: 'internal-id' }).ok).toBe(false);
    expect(parseChangelogFilters({ version: 'v0.4.36' }).ok).toBe(false);
    expect(parseChangelogFilters({ pr: ['298', '299'] }).ok).toBe(false);
    expect(parseChangelogFilters({ version: '1.2.3-..' }).ok).toBe(
      false,
    );
    expect(parseChangelogFilters({ version: '01.2.3' }).ok).toBe(
      false,
    );
    expect(
      parseChangelogFilters({ version: '1.2.3-rc.1+build.5' }).ok,
    ).toBe(true);
  });

  test('rejects unknown, duplicate, and multiply assigned entry metadata', () => {
    const invalidVersions = {
      schema: 'project-space.changelog-versions/v1',
      versions: [
        {
          version: '0.4.36',
          releasedAt: '2026-02-30',
          entryIds: ['missing-entry'],
        },
        {
          version: '0.4.35',
          releasedAt: '2026-07-20',
          entryIds: ['missing-entry'],
        },
        {
          version: '0.4.34',
          releasedAt: '2026-07-15',
          entryIds: ['missing-entry'],
        },
      ],
    };
    const result = parseChangelogCatalog(entriesSource, invalidVersions);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('real YYYY-MM-DD date');
    expect(result.errors.join('\n')).toContain('unknown entry');
    expect(result.errors.join('\n')).toContain('assigned to both');
  });

  test('rejects malformed prototype discovery metadata', () => {
    const source = structuredClone(entriesSource);
    source.entries[0]!.prototype = {
      scenarioId: 'UNKNOWN',
      surface: 'desktop-prototype',
      viewport: 'desktop',
    };
    const result = parseChangelogCatalog(source, versionsSource);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'scenarioId must use lowercase words'
    );
  });

  test('allows one release to contain multiple pull requests', () => {
    const release = structuredClone(versionsSource);
    release.versions[1]!.entryIds.push('pr-297-release-state');
    release.versions[0]!.entryIds = ['pr-296-unreleased'];
    const parsed = parseChangelogCatalog(entriesSource, release);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const view = buildChangelogView(parsed.catalog, { version: '0.4.36' });
    expect(view.state).toBe('ready');
    if (view.state !== 'ready') return;
    expect(new Set(view.groups[0]?.entries.map((entry) => entry.pullRequestNumber))).toEqual(
      new Set([298, 297]),
    );
  });
});
