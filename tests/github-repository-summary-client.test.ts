import { describe, expect, test } from 'bun:test';

import { loadGitHubRepositorySummary } from '../src/api/github-repository-summary-client';

describe('GitHub repository summary client', () => {
  test('requests one repository with browser auth and accepts exact counts', async () => {
    let request: Request | undefined;
    const result = await loadGitHubRepositorySummary('DotNaos/project-space', {
      currentHref: 'https://projects.test/projects/one',
      getAuthToken: () => 'browser-session-token',
      fetchImplementation: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          branchCount: 42,
          checkedAt: '2026-07-14T00:00:00.000Z',
          fullName: 'DotNaos/project-space',
          openIssueCount: 147,
          status: 'connected'
        });
      }
    });

    expect(result).toMatchObject({ branchCount: 42, openIssueCount: 147 });
    expect(request?.url).toBe(
      'https://projects.test/api/github/repository-summary?fullName=DotNaos%2Fproject-space'
    );
    expect(request?.headers.get('authorization')).toBe('Bearer browser-session-token');
  });

  test('rejects malformed and wrong-repository responses', async () => {
    const base = {
      currentHref: 'https://projects.test/projects/one',
      getAuthToken: () => null
    };
    await expect(
      loadGitHubRepositorySummary('DotNaos/project-space', {
        ...base,
        fetchImplementation: async () => Response.json({ status: 'connected' })
      })
    ).rejects.toThrow('invalid repository counts');
    await expect(
      loadGitHubRepositorySummary('DotNaos/project-space', {
        ...base,
        fetchImplementation: async () => Response.json({
          branchCount: 1,
          checkedAt: '2026-07-14T00:00:00.000Z',
          fullName: 'DotNaos/other',
          openIssueCount: 2,
          status: 'connected'
        })
      })
    ).rejects.toThrow('different repository');
  });
});
