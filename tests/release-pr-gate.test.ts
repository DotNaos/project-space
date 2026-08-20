import { describe, expect, test } from 'bun:test';
import {
  parsePrChangelog,
  prChangelogDirectory,
} from '../apps/docs/lib/changelog/pr-file';
import {
  validateReleasePullRequest,
  type ChangedReleaseFile,
} from '../apps/docs/lib/releases/pull-request-gate';
import {
  releaseIntentDirectory,
  releaseIntentSchema,
} from '../apps/docs/lib/releases/release-intent';

function changelogSource(bump: string, body = '# A useful change\n\nDetails.') {
  return `---\nbump: ${bump}\n---\n\n${body}\n`;
}

function legacyIntentSource(intent: string) {
  return `${JSON.stringify({ schema: releaseIntentSchema, intent }, null, 2)}\n`;
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
      changed(`${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`, {
        source: legacyIntentSource('patch'),
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
  test('accepts a safe no-release pull request with one none intent', () => {
    const result = validateReleasePullRequest({
      basePackageVersion: '0.8.2',
      changedFiles: [
        changed('src/features/project-desktop/example.tsx'),
        changed(`${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`, {
          source: legacyIntentSource('none'),
          status: 'added',
        }),
      ],
      headPackageVersion: '0.8.2',
      pullRequestNumber: 473,
    });
    expect(result).toEqual({ intent: 'none', ok: true });
  });

  test('rejects none intent for release-sensitive paths', () => {
    const result = validateReleasePullRequest({
      basePackageVersion: '0.8.2',
      changedFiles: [
        changed('cmd/project/main.go'),
        changed(`${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`, {
          source: legacyIntentSource('none'),
          status: 'added',
        }),
      ],
      headPackageVersion: '0.8.2',
      pullRequestNumber: 473,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('release-sensitive paths');
  });

  test.each([
    ['marker mutation', `${releaseIntentDirectory}/.enforced`, 'modified'],
    ['historical intent mutation', `${releaseIntentDirectory}/00000000-0000-4000-8000-000000000524.json`, 'modified'],
    ['deleted marker', `${releaseIntentDirectory}/.enforced`, 'deleted'],
  ] as const)('rejects %s alongside a valid release intent', (_label, path, status) => {
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        changed('src/main.ts'),
        changed(`${prChangelogDirectory}/473.md`, {
          source: changelogSource('patch'),
          status: 'added',
        }),
        changed(`${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`, {
          source: legacyIntentSource('patch'),
          status: 'added',
        }),
        changed(path, { status }),
      ],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('exactly one immutable release intent file');
  });

  test('accepts exactly one newly added changelog matching the PR', () => {
    expect(validateReleasePullRequest(gateInput())).toMatchObject({
      bump: 'patch',
      changelog: { pullRequest: 473 },
      ok: true,
    });
  });

  test('requires one newly added matching PR-owned release intent', () => {
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        changed('src/main.ts'),
        changed(`${prChangelogDirectory}/473.md`, {
          source: changelogSource('patch'),
          status: 'added',
        }),
      ],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('exactly one immutable release intent file');
  });

  test('accepts a new lowercase UUID intent when it matches the changelog', () => {
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        changed('src/main.ts'),
        changed(`${prChangelogDirectory}/473.md`, {
          source: changelogSource('minor'),
          status: 'added',
        }),
        changed(`${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`, {
          source: legacyIntentSource('minor'),
          status: 'added',
        }),
      ],
    }));
    expect(result).toMatchObject({ bump: 'minor', ok: true });
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

  test('rejects package version changes and mismatched legacy release intents', () => {
    const result = validateReleasePullRequest(gateInput({
      basePackageVersion: '0.8.2',
      headPackageVersion: '0.8.3',
      changedFiles: [
        changed('package.json'),
        changed(`${releaseIntentDirectory}/00000000-0000-4000-8000-000000000524.json`, {
          source: legacyIntentSource('minor'),
          status: 'added',
        }),
        changed(`${prChangelogDirectory}/473.md`, {
          source: changelogSource('patch'),
          status: 'added',
        }),
      ],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('must not change package.json version');
    expect(result.errors.join('\n')).toContain('same non-none bump');
  });

  test('allows one matching legacy intent only for the migration boundary', () => {
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        changed(`${prChangelogDirectory}/473.md`, {
          source: changelogSource('patch'),
          status: 'added',
        }),
        changed(`${releaseIntentDirectory}/00000000-0000-4000-8000-000000000524.json`, {
          source: legacyIntentSource('patch'),
          status: 'added',
        }),
      ],
    }));
    expect(result).toMatchObject({ bump: 'patch', ok: true });
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
