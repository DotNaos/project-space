import { describe, expect, test } from 'bun:test';
import { loadRepositoryDevelopmentLinks } from '../server/local-github-development-links';
import type { requestGitHubGraphQL } from '../server/github-graphql-client';

function pullRequest(number: number, overrides: Record<string, unknown> = {}) {
  return {
    headRef: { id: `REF_${number}` },
    headRefName: `issue-${number}`,
    headRepository: { nameWithOwner: 'DotNaos/project-space' },
    isCrossRepository: false,
    number,
    state: 'OPEN',
    title: `Pull request ${number}`,
    url: `https://github.com/DotNaos/project-space/pull/${number}`,
    ...overrides
  };
}

describe('GitHub development links', () => {
  test('requests linked pull requests from displayed issues and preserves the full head SHA', async () => {
    const headSha = 'a'.repeat(40);
    let query = '';
    const request = (async <Result>(_token: string, value: string) => {
      query = value;
      return {
        repository: {
          issues: {
            nodes: [{
              closedByPullRequestsReferences: {
                nodes: [pullRequest(263, { headRefOid: headSha })],
                pageInfo: { endCursor: null, hasNextPage: false }
              },
              number: 263
            }]
          }
        }
      } as Result;
    }) as typeof requestGitHubGraphQL;

    const result = await loadRepositoryDevelopmentLinks(
      'DotNaos/project-space',
      'secret-token',
      request
    );

    expect(query).toContain('closedByPullRequestsReferences(first: 100)');
    expect(query).not.toContain('pullRequests(first:');
    expect(query).toContain('headRefOid');
    expect(result.pullRequests[0]).toMatchObject({
      headRefPresent: true,
      headRepositoryFullName: 'DotNaos/project-space',
      headSha,
      isCrossRepository: false,
      linkedIssueNumbers: [263],
      number: 263
    });
  });

  test('preserves linked branches beyond the REST branch window with their exact SHA', async () => {
    const branchSha = 'b'.repeat(40);
    const request = (async <Result>() => ({
      repository: {
        issues: {
          nodes: [{
            closedByPullRequestsReferences: { nodes: [] },
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
        }
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

  test('paginates every pull request linked to one displayed issue', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const request = (async <Result>(
      _token: string,
      _query: string,
      variables: Record<string, unknown>
    ) => {
      requests.push(variables);

      if (variables.cursor) {
        return {
          repository: {
            issue: {
              closedByPullRequestsReferences: {
                nodes: [pullRequest(388)],
                pageInfo: { endCursor: null, hasNextPage: false }
              }
            }
          }
        } as Result;
      }

      return {
        repository: {
          issues: {
            nodes: [{
              closedByPullRequestsReferences: {
                nodes: [pullRequest(420)],
                pageInfo: { endCursor: 'more-linked-prs', hasNextPage: true }
              },
              number: 398
            }]
          }
        }
      } as Result;
    }) as typeof requestGitHubGraphQL;

    const result = await loadRepositoryDevelopmentLinks(
      'DotNaos/project-space',
      'secret-token',
      request
    );

    expect(requests).toEqual([
      { name: 'project-space', owner: 'DotNaos' },
      {
        cursor: 'more-linked-prs',
        issueNumber: 398,
        name: 'project-space',
        owner: 'DotNaos'
      }
    ]);
    expect(result.pullRequests.map((item) => item.number)).toEqual([420, 388]);
    expect(result.pullRequests.every(
      (item) => item.linkedIssueNumbers?.[0] === 398
    )).toBe(true);
  });

  test('deduplicates one pull request linked to several displayed issues', async () => {
    const sharedPullRequest = pullRequest(420, { updatedAt: '2026-07-30T12:00:00Z' });
    const request = (async <Result>() => ({
      repository: {
        issues: {
          nodes: [
            {
              closedByPullRequestsReferences: {
                nodes: [sharedPullRequest],
                pageInfo: { endCursor: null, hasNextPage: false }
              },
              number: 398
            },
            {
              closedByPullRequestsReferences: {
                nodes: [sharedPullRequest],
                pageInfo: { endCursor: null, hasNextPage: false }
              },
              number: 419
            }
          ]
        }
      }
    }) as Result) as typeof requestGitHubGraphQL;

    const result = await loadRepositoryDevelopmentLinks(
      'DotNaos/project-space',
      'secret-token',
      request
    );

    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]?.linkedIssueNumbers).toEqual([398, 419]);
  });
});
