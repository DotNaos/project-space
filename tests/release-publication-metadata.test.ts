import { describe, expect, test } from 'bun:test';
import {
  parseReleasePublication,
  publicationMatchesDeployment,
} from '../apps/docs/lib/releases/publication';

const commit = 'a'.repeat(40);
const publication = {
  commit,
  githubReleaseUrl:
    'https://github.com/DotNaos/project-space/releases/tag/v0.4.44',
  publishedAt: '2026-07-30T12:00:00Z',
  sourceRevision: commit,
  status: 'Latest',
  tag: 'v0.4.44',
  version: '0.4.44',
};

describe('generated release publication metadata', () => {
  test('accepts one matching tag, URL, commit, source, and date', () => {
    const result = parseReleasePublication(publication, '0.4.44');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      publicationMatchesDeployment(result.publication, {
        backHref: '/',
        backLabel: 'Back to Project Space',
        commit,
        state: 'production',
        version: '0.4.44',
      }),
    ).toBe(true);
  });

  test.each([
    ['tag', { tag: 'v0.4.45' }],
    ['release URL', { githubReleaseUrl: 'https://example.com/release' }],
    ['commit', { commit: 'b'.repeat(40) }],
    ['source revision', { sourceRevision: 'b'.repeat(40) }],
    ['publication date', { publishedAt: 'not-a-date' }],
    ['status', { status: 'Unknown' }],
  ])('rejects mismatched %s metadata', (_label, override) => {
    const result = parseReleasePublication(
      { ...publication, ...override },
      '0.4.44',
    );
    expect(result.ok).toBe(false);
  });

  test('requires the latest Docs and application identity to match', () => {
    const result = parseReleasePublication(publication, '0.4.44');
    if (!result.ok) throw new Error(result.error);

    expect(
      publicationMatchesDeployment(result.publication, {
        backHref: '/',
        backLabel: 'Back to Project Space',
        commit: 'b'.repeat(40),
        state: 'production',
        version: '0.4.44',
      }),
    ).toBe(false);
    expect(
      publicationMatchesDeployment(result.publication, {
        backHref: '/',
        backLabel: 'Back to Project Space',
        commit,
        state: 'production',
        version: '0.4.45',
      }),
    ).toBe(false);
  });
});
