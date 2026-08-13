import { describe, expect, test } from 'bun:test';

import {
  loadReleaseChangelog,
  releaseChangelogForVersion
} from '../server/release-changelog';

function release(version: string, overrides: Record<string, unknown> = {}) {
  return {
    body: `<!-- internal marker -->\n## Changes in ${version}`,
    draft: false,
    html_url: `https://github.com/DotNaos/project-space/releases/tag/v${version}`,
    name: `Release ${version}`,
    prerelease: false,
    published_at: '2026-08-01T12:00:00Z',
    tag_name: `v${version}`,
    ...overrides
  };
}

describe('release changelog service', () => {
  test('returns published releases up to the version that is actually running', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const result = await loadReleaseChangelog('0.9.1', {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return Response.json([
          release('0.8.3'),
          release('0.10.0'),
          release('0.9.1'),
          release('0.9.0'),
          release('0.8.4', { draft: true }),
          release('0.8.5', { prerelease: true }),
          release('0.8.6', { html_url: 'https://example.com/not-canonical' })
        ]);
      }) as typeof fetch,
      now: () => new Date('2026-08-09T10:00:00Z')
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      'https://api.github.com/repos/DotNaos/project-space/releases?per_page=100'
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      accept: 'application/vnd.github+json'
    });
    expect(result.currentVersion).toBe('0.9.1');
    expect(result.currentReleaseAvailable).toBe(true);
    expect(result.releases.map((entry) => entry.version)).toEqual([
      '0.9.1',
      '0.9.0',
      '0.8.3'
    ]);
    expect(result.releases[0]?.body).toBe('## Changes in 0.9.1');
    expect(result.checkedAt).toBe('2026-08-09T10:00:00.000Z');
  });

  test('keeps older history available when the current release is missing', async () => {
    const result = await loadReleaseChangelog('0.9.1', {
      fetch: (async () => Response.json([release('0.9.0')])) as typeof fetch
    });

    expect(result.currentReleaseAvailable).toBe(false);
    expect(result.releases.map((entry) => entry.version)).toEqual(['0.9.0']);
  });

  test('loads every page of published release history', async () => {
    const calls: string[] = [];
    const firstPage = Array.from(
      { length: 100 },
      (_, patch) => release(`1.0.${patch}`)
    );
    const result = await loadReleaseChangelog('1.0.99', {
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        return Response.json(url.endsWith('&page=2')
          ? [release('0.9.0')]
          : firstPage);
      }) as typeof fetch
    });

    expect(calls).toEqual([
      'https://api.github.com/repos/DotNaos/project-space/releases?per_page=100',
      'https://api.github.com/repos/DotNaos/project-space/releases?per_page=100&page=2'
    ]);
    expect(result.releases).toHaveLength(101);
    expect(result.releases.at(-1)?.version).toBe('0.9.0');
  });

  test('authenticates the server-side GitHub request when a token is configured', async () => {
    let authorization: string | undefined;
    await loadReleaseChangelog('0.9.1', {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get('authorization') ?? undefined;
        return Response.json([release('0.9.1')]);
      }) as typeof fetch,
      githubToken: 'trusted-server-token'
    });

    expect(authorization).toBe('Bearer trusted-server-token');
  });

  test('never creates an authorization header from an empty or malformed token', async () => {
    const authorizations: Array<string | null> = [];
    const fetchRelease = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      return Response.json([release('0.9.1')]);
    }) as typeof fetch;

    await loadReleaseChangelog('0.9.1', { fetch: fetchRelease, githubToken: '' });
    await loadReleaseChangelog('0.9.1', {
      fetch: fetchRelease,
      githubToken: 'invalid\nheader'
    });

    expect(authorizations).toEqual([null, null]);
  });

  test('does not contact GitHub for an unverified build version', async () => {
    let called = false;
    const result = await releaseChangelogForVersion('unknown', {
      fetch: (async () => {
        called = true;
        return Response.json([]);
      }) as typeof fetch,
      now: () => new Date('2026-08-09T10:00:00Z')
    });

    expect(called).toBe(false);
    expect(result.currentVersion).toBe('unknown');
    expect(result.releases).toEqual([]);
  });
});
