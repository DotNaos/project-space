import { describe, expect, test } from 'bun:test';
import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';

export function releaseEntryFixture(
  overrides: {
    body?: string;
    frontmatter?: string;
    pullRequest?: number;
    version?: string;
  } = {},
) {
  const pullRequest = overrides.pullRequest ?? 403;
  const version = overrides.version ?? '0.4.44';
  const frontmatter =
    overrides.frontmatter ??
    `title: "Structured release navigation"
version: "${version}"
bump: "patch"
pullRequest: ${pullRequest}
issues:
  - 298
areas:
  - docs
breaking: false
upgrade: "none"`;
  const body =
    overrides.body ??
    `<ReleaseSummary>
  Project Docs now group releases by major, minor, and patch version
  while keeping every patch in a continuous release article.
</ReleaseSummary>

## Changes

### Added

- Collapsible major and minor release groups
- Direct links to individual patch releases

### Changed

- Replaced the standalone history with structured release navigation

## Upgrade notes

<UpgradeNotes type="none">
  No manual action is required.
</UpgradeNotes>

<PreviewOnly>

## What to test

- Open and collapse the major and minor release groups.
- Select a patch version and confirm that the page scrolls to it.

</PreviewOnly>`;

  return `---
${frontmatter}
---

${body}
`;
}

describe('versioned release MDX schema', () => {
  test('parses the approved authoring contract', () => {
    const result = parseReleaseEntryMdx(
      releaseEntryFixture(),
      '403.mdx',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry).toMatchObject({
      areas: ['docs'],
      breaking: false,
      bump: 'patch',
      changes: [
        {
          category: 'Added',
          items: [
            'Collapsible major and minor release groups',
            'Direct links to individual patch releases',
          ],
        },
        {
          category: 'Changed',
          items: [
            'Replaced the standalone history with structured release navigation',
          ],
        },
      ],
      issues: [298],
      previewTests: [
        'Open and collapse the major and minor release groups.',
        'Select a patch version and confirm that the page scrolls to it.',
      ],
      pullRequest: 403,
      upgrade: 'none',
      upgradeNotes: ['No manual action is required.'],
      version: '0.4.44',
    });
  });

  test.each([
    ['an import', '\nimport Danger from "danger"\n'],
    ['an export', '\nexport const secret = process.env.SECRET\n'],
    ['an expression', '\n{globalThis.process.env}\n'],
    ['raw HTML', '\n<script>alert(1)</script>\n'],
    ['an unsafe link', '\n[run this](javascript:alert(1))\n'],
    ['an image', '\n![credential](https://example.com/secret.png)\n'],
  ])('rejects unsafe MDX containing %s', (_label, unsafe) => {
    const source = releaseEntryFixture().replace(
      '## Changes',
      `${unsafe}\n## Changes`,
    );
    const result = parseReleaseEntryMdx(source, '403.mdx');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toMatch(
      /not allowed|may not|expressions|link|images|order/i,
    );
  });

  test('rejects empty placeholders and unsupported categories', () => {
    const source = releaseEntryFixture({
      body: `<ReleaseSummary>TODO: add a useful summary later.</ReleaseSummary>

## Changes

### Improved

- Placeholder

## Upgrade notes

<UpgradeNotes type="none">No manual action is required.</UpgradeNotes>

<PreviewOnly>

## What to test

- TBD

</PreviewOnly>`,
    });
    const result = parseReleaseEntryMdx(source, '403.mdx');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('placeholder');
    expect(result.errors.join('\n')).toContain(
      'at least one non-empty supported category',
    );
  });

  test('requires the filename and pullRequest to agree', () => {
    const result = parseReleaseEntryMdx(
      releaseEntryFixture(),
      '404.mdx',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'must match pullRequest 403',
    );
  });

  test('rejects breaking patch releases and contradictory upgrade state', () => {
    const source = releaseEntryFixture({
      frontmatter: `title: "Breaking patch"
version: "0.4.44"
bump: "patch"
pullRequest: 403
issues: []
areas:
  - docs
breaking: true
upgrade: "none"`,
      body: `<ReleaseSummary>
  This release intentionally changes an incompatible documentation contract.
</ReleaseSummary>

## Changes

### Changed

- Changed the public contract

## Breaking changes

- Existing links must be replaced.

## Upgrade notes

<UpgradeNotes type="required">
  Replace all existing links before upgrading.
</UpgradeNotes>

<PreviewOnly>

## What to test

- Confirm the replacement links work.

</PreviewOnly>`,
    });
    const result = parseReleaseEntryMdx(source, '403.mdx');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      'Patch releases may not declare breaking changes.',
    );
    expect(result.errors.join('\n')).toContain('contradicts');
  });

  test('requires Preview-only testing guidance', () => {
    const source = releaseEntryFixture().replace(
      '- Open and collapse the major and minor release groups.\n- Select a patch version and confirm that the page scrolls to it.',
      '',
    );
    const result = parseReleaseEntryMdx(source, '403.mdx');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'What to test must contain at least one',
    );
  });
});
