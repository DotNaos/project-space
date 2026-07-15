import { describe, expect, test } from 'bun:test';

import { loadLocalGitHubRepositorySummary } from '../server/local-github-repository-summary';

describe('scoped GitHub repository summary', () => {
  test('uses exact GraphQL connection totals beyond the truncated detail lists', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const result = await loadLocalGitHubRepositorySummary('DotNaos/project-space', {
      getGitHubClientId: () => 'client-id',
      async requestGraphQL(_token, query, variables) {
        calls.push({ query, variables });
        return {
          repository: {
            issues: { totalCount: 147 },
            refs: { totalCount: 42 }
          }
        };
      },
      async resolveToken() {
        return { token: 'server-only-token' };
      }
    });

    expect(result).toMatchObject({
      branchCount: 42,
      fullName: 'DotNaos/project-space',
      openIssueCount: 147,
      status: 'connected'
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain('refs(refPrefix: "refs/heads/", first: 1)');
    expect(calls[0]?.query).toContain('issues(states: OPEN, first: 1)');
    expect(calls[0]?.variables).toEqual({ name: 'project-space', owner: 'DotNaos' });
  });

  test('keeps authentication and invalid GitHub evidence honest', async () => {
    let requests = 0;
    const dependencies = {
      getGitHubClientId: () => 'client-id',
      async requestGraphQL() {
        requests += 1;
        return { repository: null };
      },
      async resolveToken() {
        return null;
      }
    };

    expect(
      await loadLocalGitHubRepositorySummary('DotNaos/project-space', dependencies)
    ).toMatchObject({ status: 'auth-required' });
    expect(
      await loadLocalGitHubRepositorySummary('../secrets', dependencies)
    ).toMatchObject({ status: 'error' });
    expect(requests).toBe(0);

    const invalid = await loadLocalGitHubRepositorySummary('DotNaos/project-space', {
      ...dependencies,
      async resolveToken() {
        return { token: 'server-only-token' };
      }
    });
    expect(invalid).toMatchObject({
      fullName: 'DotNaos/project-space',
      status: 'error'
    });
  });

  test('proves an empty repository has zero branches without inventing missing issue evidence', async () => {
    const result = await loadLocalGitHubRepositorySummary('DotNaos/empty', {
      getGitHubClientId: () => 'client-id',
      async requestGraphQL() {
        return {
          repository: {
            issues: { totalCount: 0 },
            refs: null
          }
        };
      },
      async resolveToken() {
        return { token: 'server-only-token' };
      }
    });

    expect(result).toMatchObject({
      branchCount: 0,
      openIssueCount: 0,
      status: 'connected'
    });
  });
});
