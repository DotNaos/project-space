import { describe, expect, test } from 'bun:test';
import { loadRepositoryDevelopmentLinks, normalizeChecksStatus } from '../server/local-github-development-links';
import type { requestGitHubGraphQL } from '../server/github-graphql-client';

describe('GitHub development links', () => {
  test('requests and preserves the full pull request head SHA', async () => {
    const headSha = 'a'.repeat(40);
    let query = '';
    const request = (async <Result>(_token: string, value: string) => {
      query = value;
      return {
        repository: {
          issues: { nodes: [] },
          pullRequests: { nodes: [{
            author: { avatarUrl: 'https://avatars.example/263.png', login: 'octocat' },
            baseRefName: 'main',
            closingIssuesReferences: { nodes: [{ number: 263 }] },
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
            headRef: { id: 'REF_263' },
            headRefName: 'issue-263-preview',
            headRefOid: headSha,
            headRepository: { nameWithOwner: 'DotNaos/project-space' },
            isDraft: true,
            isCrossRepository: false,
            number: 263,
            state: 'OPEN',
            title: 'Preview deployments',
            url: 'https://github.com/DotNaos/project-space/pull/263'
          }] }
        }
      } as Result;
    }) as typeof requestGitHubGraphQL;

    const result = await loadRepositoryDevelopmentLinks(
      'DotNaos/project-space',
      'secret-token',
      request
    );

    expect(query).toContain('headRefOid');
    expect(query).toContain('baseRefName');
    expect(query).toContain('statusCheckRollup');
    expect(query).toContain('avatarUrl');
    expect(result.pullRequests[0]).toMatchObject({
      author: { avatarUrl: 'https://avatars.example/263.png', login: 'octocat' },
      baseBranch: 'main',
      checksStatus: 'passing',
      headRefPresent: true,
      headRepositoryFullName: 'DotNaos/project-space',
      headSha,
      isDraft: true,
      isCrossRepository: false,
      number: 263
    });
  });

  test('falls back to an undefined author when GitHub omits the login', async () => {
    const request = (async <Result>() => ({
      repository: {
        issues: { nodes: [] },
        pullRequests: { nodes: [{
          author: null,
          number: 1,
          state: 'OPEN',
          title: 'No author',
          url: 'https://github.com/DotNaos/project-space/pull/1'
        }] }
      }
    }) as Result) as typeof requestGitHubGraphQL;

    const result = await loadRepositoryDevelopmentLinks('DotNaos/project-space', 'secret-token', request);
    expect(result.pullRequests[0]?.author).toBeUndefined();
    expect(result.pullRequests[0]?.checksStatus).toBe('unknown');
  });

  test('normalizes the StatusCheckRollupState enum into the Previews UI union', () => {
    expect(normalizeChecksStatus('SUCCESS')).toBe('passing');
    expect(normalizeChecksStatus('FAILURE')).toBe('failing');
    expect(normalizeChecksStatus('ERROR')).toBe('failing');
    expect(normalizeChecksStatus('PENDING')).toBe('pending');
    expect(normalizeChecksStatus('EXPECTED')).toBe('pending');
    expect(normalizeChecksStatus(null)).toBe('unknown');
    expect(normalizeChecksStatus(undefined)).toBe('unknown');
    expect(normalizeChecksStatus('something-unexpected')).toBe('unknown');
  });

  test('preserves linked branches beyond the REST branch window with their exact SHA', async () => {
    const branchSha = 'b'.repeat(40);
    const request = (async <Result>() => ({
      repository: {
        issues: {
          nodes: [{
            linkedBranches: {
              nodes: [{
                ref: {
                  name: 'issue-408-graph',
                  target: { oid: branchSha }
                }
              }]
            },
            number: 408
          }]
        },
        pullRequests: { nodes: [] }
      }
    }) as Result) as typeof requestGitHubGraphQL;

    const result = await loadRepositoryDevelopmentLinks(
      'DotNaos/project-space',
      'secret-token',
      request
    );

    expect(result.linkedBranches).toEqual([{
      commitSha: branchSha,
      isDefault: false,
      linkedIssueNumbers: [408],
      name: 'issue-408-graph'
    }]);
  });
});
