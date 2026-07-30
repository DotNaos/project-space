import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildChangelogView,
  parseChangelogCatalog,
} from '../apps/docs/lib/changelog/model';
import { withReleaseChangelogEntries } from '../apps/docs/lib/changelog/release-catalog';
import { parseReleaseCatalog } from '../apps/docs/lib/releases/catalog';
import { previewTestsForExactBuild } from '../apps/docs/lib/releases/preview';

const emptyEntries = {
  entries: [],
  schema: 'project-space.changelog/v1',
};
const emptyVersions = {
  schema: 'project-space.changelog-versions/v1',
  versions: [],
};
const head = '7'.repeat(40);

function releaseCatalog() {
  return parseReleaseCatalog(new Map([
    [
      '409.mdx',
      readFileSync(
        'apps/docs/content/docs/releases/entries/409.mdx',
        'utf8',
      ),
    ],
  ]));
}

function baseCatalog() {
  return parseChangelogCatalog(emptyEntries, emptyVersions);
}

function prototypeCatalog() {
  return parseChangelogCatalog(
    {
      entries: [{
        body: 'Exercise the exact prototype.',
        category: 'added',
        id: 'pr-409-release-docs-prototype',
        prototype: {
          scenarioId: 'release-docs',
          surface: 'desktop-prototype',
          viewport: 'desktop',
        },
        pullRequestNumber: 409,
        summary: 'Review the release Docs prototype.',
        testing: ['Open the exact Change prototype.'],
      }],
      schema: 'project-space.changelog/v1',
    },
    emptyVersions,
  );
}

describe('release entries in the Docs changelog', () => {
  test('shows every Change under its version for the owning PR', () => {
    const result = withReleaseChangelogEntries(
      baseCatalog(),
      releaseCatalog(),
      (entry) => previewTestsForExactBuild(
        entry,
        {
          PROJECT_SPACE_BUILD_COMMIT: head,
          PROJECT_SPACE_PREVIEW_HEAD_SHA: head,
          PROJECT_SPACE_PREVIEW_MODE: '1',
          PROJECT_SPACE_PREVIEW_PR_NUMBER: '409',
          PROJECT_SPACE_PREVIEW_REPOSITORY:
            'DotNaos/project-space',
        },
        '0.4.46',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = buildChangelogView(result.catalog, {
      pullRequestNumber: 409,
    });
    expect(view.state).toBe('ready');
    if (view.state !== 'ready') return;
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.label).toBe('0.4.46');
    expect(view.groups[0]?.entries).toHaveLength(9);
    expect(
      view.groups[0]?.entries.every(
        (entry) =>
          entry.pullRequestNumber === 409 &&
          entry.testing.length === 0,
      ),
    ).toBe(true);
    expect(view.groups[0]?.releaseTesting).toHaveLength(1);
    expect(
      view.groups[0]?.releaseTesting[0]?.pullRequestNumber,
    ).toBe(409);
    expect(
      view.groups[0]?.releaseTesting[0]?.items,
    ).toHaveLength(7);
  });

  test('omits Preview-only testing outside the exact PR head', () => {
    const result = withReleaseChangelogEntries(
      prototypeCatalog(),
      releaseCatalog(),
      (entry) => previewTestsForExactBuild(
        entry,
        {
          PROJECT_SPACE_BUILD_COMMIT: head,
          PROJECT_SPACE_PREVIEW_HEAD_SHA: head,
          PROJECT_SPACE_PREVIEW_MODE: '1',
          PROJECT_SPACE_PREVIEW_PR_NUMBER: '410',
          PROJECT_SPACE_PREVIEW_REPOSITORY:
            'DotNaos/project-space',
        },
        '0.4.46',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = buildChangelogView(result.catalog, {
      version: '0.4.46',
    });
    expect(view.state).toBe('ready');
    if (view.state !== 'ready') return;
    expect(
      view.groups[0]?.entries.every(
        (entry) => entry.testing.length === 0,
      ),
    ).toBe(true);
    expect(view.groups[0]?.releaseTesting).toEqual([]);
  });

  test('keeps prototype Changes in the same release version', () => {
    const result = withReleaseChangelogEntries(
      prototypeCatalog(),
      releaseCatalog(),
      (entry) => entry.previewTests,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = buildChangelogView(result.catalog, {
      pullRequestNumber: 409,
    });
    expect(view.state).toBe('ready');
    if (view.state !== 'ready') return;
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.label).toBe('0.4.46');
    expect(view.groups[0]?.entries).toHaveLength(10);
    expect(
      view.groups[0]?.entries.find(
        (entry) =>
          entry.id === 'pr-409-release-docs-prototype',
      ),
    ).toMatchObject({
      prototype: {
        scenarioId: 'release-docs',
        surface: 'desktop-prototype',
        viewport: 'desktop',
      },
      testing: ['Open the exact Change prototype.'],
    });
    expect(view.groups[0]?.releaseTesting).toHaveLength(1);
  });

  test('fails closed on legacy id or version collisions', () => {
    const base = parseChangelogCatalog(
      {
        entries: [{
          body: 'Existing body.',
          category: 'added',
          id: 'release-0-4-46-added-1',
          pullRequestNumber: 400,
          summary: 'Existing summary.',
          testing: ['Test the existing change.'],
        }],
        schema: 'project-space.changelog/v1',
      },
      {
        schema: 'project-space.changelog-versions/v1',
        versions: [{
          entryIds: ['release-0-4-46-added-1'],
          releasedAt: '2026-07-29',
          version: '0.4.46',
        }],
      },
    );
    const result = withReleaseChangelogEntries(
      base,
      releaseCatalog(),
      () => undefined,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'duplicates an existing changelog entry',
    );
    expect(result.errors.join('\n')).toContain(
      'already documented by the legacy changelog source',
    );
  });
});
