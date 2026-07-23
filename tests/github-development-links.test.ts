import { describe, expect, test } from 'bun:test';
import { loadRepositoryDevelopmentLinks } from '../server/local-github-development-links';
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
            closingIssuesReferences: { nodes: [{ number: 263 }] },
            headRefName: 'issue-263-preview',
            headRefOid: headSha,
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
    expect(result.pullRequests[0]).toMatchObject({ headSha, number: 263 });
  });
});
