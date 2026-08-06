import { describe, expect, test } from 'bun:test';
import { validateReleasePullRequest } from '../apps/docs/lib/releases/pull-request-gate';
import { releaseEntryFixture } from './release-entry-schema.test';

const directory = 'apps/docs/content/docs/releases/entries/';

function gateInput(
  overrides: Partial<
    Parameters<typeof validateReleasePullRequest>[0]
  > = {},
) {
  const source = releaseEntryFixture();
  return {
    changedReleaseFiles: [
      {
        path: `${directory}403.mdx`,
        source,
        status: 'added' as const,
      },
    ],
    currentMainVersion: '0.4.43',
    existingGithubReleaseTags: new Set<string>(),
    existingGitTags: new Set<string>(),
    headEntries: new Map([['403.mdx', source]]),
    headPackageVersion: '0.4.44',
    mainEntries: new Map<string, string>(),
    pullRequestNumber: 403,
    ...overrides,
  };
}

describe('pull request release gate', () => {
  test('accepts exactly one owned entry with the exact next patch', () => {
    const result = validateReleasePullRequest(gateInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('release');
    if (result.mode !== 'release') return;
    expect(result.entry.version).toBe('0.4.44');
  });

  test('accepts an ordinary PR without a version or release-catalog change', () => {
    expect(validateReleasePullRequest(gateInput({
      changedReleaseFiles: [],
      headEntries: new Map<string, string>(),
      headPackageVersion: '0.4.43',
    }))).toEqual({ mode: 'ordinary', ok: true });
  });

  test('requires a release entry when package.json changes', () => {
    const result = validateReleasePullRequest(gateInput({
      changedReleaseFiles: [],
      headEntries: new Map<string, string>(),
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'changes package.json from 0.4.43 to 0.4.44 without one release MDX file',
    );
  });

  test('rejects missing, multiple, modified, or mismatched entries', () => {
    const source = releaseEntryFixture();
    const cases = [
      gateInput({
        changedReleaseFiles: [
          {
            path: `${directory}403.mdx`,
            source,
            status: 'added',
          },
          {
            path: `${directory}404.mdx`,
            source,
            status: 'added',
          },
        ],
      }),
      gateInput({
        changedReleaseFiles: [
          {
            path: `${directory}403.mdx`,
            source,
            status: 'modified',
          },
        ],
      }),
      gateInput({
        changedReleaseFiles: [
          {
            path: `${directory}999.mdx`,
            source,
            status: 'added',
          },
        ],
      }),
    ];

    for (const input of cases) {
      expect(validateReleasePullRequest(input).ok).toBe(false);
    }
  });

  test('rejects non-increasing, bump-inconsistent, and package-mismatched versions', () => {
    const inconsistent = releaseEntryFixture({
      frontmatter: `title: "Wrong release bump"
version: "0.5.1"
bump: "minor"
pullRequest: 403
issues: []
areas:
  - docs
breaking: false
upgrade: "none"`,
    });
    const result = validateReleasePullRequest(
      gateInput({
        changedReleaseFiles: [
          {
            path: `${directory}403.mdx`,
            source: inconsistent,
            status: 'added',
          },
        ],
        headEntries: new Map([['403.mdx', inconsistent]]),
        headPackageVersion: '0.5.2',
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'must use version 0.5.0',
    );
    expect(result.errors.join('\n')).toContain(
      'must match package.json version',
    );
  });

  test('rejects duplicates across entries, Git tags, and GitHub Releases', () => {
    const mainSource = releaseEntryFixture({
      pullRequest: 402,
    });
    const result = validateReleasePullRequest(
      gateInput({
        existingGithubReleaseTags: new Set(['v0.4.44']),
        existingGitTags: new Set(['v0.4.44']),
        mainEntries: new Map([['402.mdx', mainSource]]),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'already owned by a release entry',
    );
    expect(result.errors.join('\n')).toContain('Git tag v0.4.44');
    expect(result.errors.join('\n')).toContain(
      'GitHub Release v0.4.44',
    );
  });

  test('blocks the second parallel PR after latest main takes its version', () => {
    const initiallyPassing = validateReleasePullRequest(gateInput());
    expect(initiallyPassing.ok).toBe(true);

    const mergedFirstPr = releaseEntryFixture({
      pullRequest: 402,
    });
    const revalidated = validateReleasePullRequest(
      gateInput({
        currentMainVersion: '0.4.44',
        mainEntries: new Map([['402.mdx', mergedFirstPr]]),
      }),
    );

    expect(revalidated.ok).toBe(false);
    if (revalidated.ok) return;
    expect(revalidated.errors.join('\n')).toContain(
      'must use version 0.4.45',
    );
    expect(revalidated.errors.join('\n')).toContain(
      'already owned by a release entry',
    );
  });
});
