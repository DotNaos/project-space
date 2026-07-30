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
            headRef: { id: 'REF_263' },
            headRefName: 'issue-263-preview',
            headRefOid: headSha,
            headRepository: { nameWithOwner: 'DotNaos/project-space' },
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
    expect(result.pullRequests[0]).toMatchObject({
      headRefPresent: true,
      headRepositoryFullName: 'DotNaos/project-space',
      headSha,
      isCrossRepository: false,
      number: 263
    });
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

  test('loads pull requests beyond the first GraphQL page', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const request = (async <Result>(
      _token: string,
      _query: string,
      variables: Record<string, unknown>
    ) => {
      requests.push(variables);

      if (!variables.pullRequestCursor) {
        return {
          repository: {
            issues: { nodes: [] },
            pullRequests: {
              nodes: [{
                closingIssuesReferences: { nodes: [] },
                number: 420,
                state: 'OPEN',
                title: 'Current pull request',
                url: 'https://github.com/DotNaos/project-space/pull/420'
              }],
              pageInfo: { endCursor: 'older-prs', hasNextPage: true }
            }
          }
        } as Result;
      }

      return {
        repository: {
          issues: { nodes: [] },
          pullRequests: {
            nodes: [{
              closingIssuesReferences: { nodes: [{ number: 398 }] },
              number: 388,
              state: 'OPEN',
              title: 'Older pull request',
              url: 'https://github.com/DotNaos/project-space/pull/388'
            }],
            pageInfo: { endCursor: null, hasNextPage: false }
          }
        }
      } as Result;
    }) as typeof requestGitHubGraphQL;

    const result = await loadRepositoryDevelopmentLinks(
      'DotNaos/project-space',
      'secret-token',
      request
    );

    expect(requests.map((variables) => variables.pullRequestCursor)).toEqual([
      null,
      'older-prs'
    ]);
    expect(result.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([
      420,
      388
    ]);
    expect(result.pullRequests[1]?.linkedIssueNumbers).toEqual([398]);
  });

  test('loads every closing issue linked to a pull request', async () => {
    const queries: string[] = [];
    const request = (async <Result>(
      _token: string,
      query: string,
      variables: Record<string, unknown>
    ) => {
      queries.push(query);

      if (variables.closingIssueCursor) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 399 }],
                pageInfo: { endCursor: null, hasNextPage: false }
              }
            }
          }
        } as Result;
      }

      return {
        repository: {
          issues: { nodes: [] },
          pullRequests: {
            nodes: [{
              closingIssuesReferences: {
                nodes: [{ number: 398 }],
                pageInfo: { endCursor: 'more-issues', hasNextPage: true }
              },
              number: 420,
              state: 'OPEN',
              title: 'Board status model',
              url: 'https://github.com/DotNaos/project-space/pull/420'
            }],
            pageInfo: { endCursor: null, hasNextPage: false }
          }
        }
      } as Result;
    }) as typeof requestGitHubGraphQL;

    const result = await loadRepositoryDevelopmentLinks(
      'DotNaos/project-space',
      'secret-token',
      request
    );

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('pullRequests(');
    expect(queries[0]).toContain('pageInfo');
    expect(queries[1]).toContain('closingIssuesReferences(first: 100, after: $closingIssueCursor)');
    expect(result.pullRequests[0]?.linkedIssueNumbers).toEqual([398, 399]);
  });
});
