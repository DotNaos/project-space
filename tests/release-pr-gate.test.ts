import { describe, expect, test } from 'bun:test';
import {
  parsePrChangelog,
  prChangelogDirectory,
} from '../apps/docs/lib/changelog/pr-file';
import {
  validateReleasePullRequest,
  type ChangedReleaseFile,
} from '../apps/docs/lib/releases/pull-request-gate';
import { releaseIntentDirectory } from '../apps/docs/lib/releases/release-intent';

function changelogSource(bump: string, body = '# A useful change\n\nDetails.') {
  return `---\nbump: ${bump}\n---\n\n${body}\n`;
}

function changed(
  path: string,
  overrides: Partial<ChangedReleaseFile> = {},
): ChangedReleaseFile {
  return { path, source: 'changed\n', status: 'modified', ...overrides };
}

function gateInput(
  overrides: Partial<Parameters<typeof validateReleasePullRequest>[0]> = {},
) {
  return {
    basePackageVersion: '0.8.2',
    changedFiles: [
      changed('src/features/project-desktop/example.tsx'),
      changed(`${prChangelogDirectory}/473.md`, {
        source: changelogSource('patch'),
        status: 'added',
      }),
    ],
    headPackageVersion: '0.8.2',
    pullRequestNumber: 473,
    ...overrides,
  };
}

describe('raw PR changelog parser', () => {
  test.each(['patch', 'minor', 'major'] as const)(
    'accepts a %s bump and preserves the raw body',
    (bump) => {
      expect(parsePrChangelog(changelogSource(bump), '473.md')).toEqual({
        changelog: {
          body: '# A useful change\n\nDetails.',
          bump,
          fileName: '473.md',
          pullRequest: 473,
          summary: 'A useful change',
        },
        ok: true,
      });
    },
  );

  test.each([
    ['none', 'none is not allowed'],
    ['missing', 'must start with YAML frontmatter'],
    ['extra metadata', 'frontmatter may contain only the bump field'],
  ])('rejects %s metadata', (_label, expected) => {
    const source = _label === 'missing'
      ? '---\n---\n\nText\n'
      : _label === 'extra metadata'
        ? '---\nbump: patch\ntitle: Nope\n---\n\nText\n'
        : changelogSource('none');
    expect(parsePrChangelog(source, '473.md').ok).toBe(false);
    expect(parsePrChangelog(source, '473.md')).toMatchObject({
      errors: expect.arrayContaining([expect.stringContaining(expected)]),
    });
  });

  test('requires frontmatter, body, and a numeric markdown filename', () => {
    for (const [source, fileName] of [
      ['text', '473.md'],
      ['---\nbump: patch\n---\n', '473.md'],
      [changelogSource('patch'), 'nested/473.md'],
    ] as const) {
      expect(parsePrChangelog(source, fileName).ok).toBe(false);
    }
  });
});

describe('pull request changelog gate', () => {
  test('accepts exactly one newly added changelog matching the PR', () => {
    expect(validateReleasePullRequest(gateInput())).toMatchObject({
      bump: 'patch',
      changelog: { pullRequest: 473 },
      ok: true,
    });
  });

  test.each([
    ['missing', []],
    ['two files', [
      changed(`${prChangelogDirectory}/473.md`, { source: changelogSource('patch'), status: 'added' }),
      changed(`${prChangelogDirectory}/474.md`, { source: changelogSource('minor'), status: 'added' }),
    ]],
    ['wrong PR filename', [
      changed(`${prChangelogDirectory}/474.md`, { source: changelogSource('patch'), status: 'added' }),
    ]],
    ['modified history', [
      changed(`${prChangelogDirectory}/473.md`, { source: changelogSource('patch'), status: 'modified' }),
    ]],
  ] as const)('rejects %s changelog ownership', (_label, files) => {
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [changed('src/main.ts'), ...files],
    }));
    expect(result.ok).toBe(false);
  });

  test('rejects package version changes and legacy release intents', () => {
    const result = validateReleasePullRequest(gateInput({
      basePackageVersion: '0.8.2',
      headPackageVersion: '0.8.3',
      changedFiles: [
        changed('package.json'),
        changed(`${releaseIntentDirectory}/legacy.json`, { status: 'added' }),
        changed(`${prChangelogDirectory}/473.md`, {
          source: changelogSource('patch'),
          status: 'added',
        }),
      ],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('must not change package.json version');
    expect(result.errors.join('\n')).toContain('legacy release-intents');
  });

  test('keeps historical release entries immutable', () => {
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        changed('apps/docs/content/docs/releases/entries/486.mdx'),
        changed(`${prChangelogDirectory}/473.md`, {
          source: changelogSource('patch'),
          status: 'added',
        }),
      ],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('486.mdx');
  });
});
