import { describe, expect, test } from 'bun:test';

import {
  listRepositoryIssueHierarchy,
  listRepositoryIssues,
  mapGitHubIssue,
  mapGitHubIssueHierarchy,
  type RequestGitHubGraphQL,
  type requestGitHub
} from '../server/local-github-catalog';

describe('GitHub repository issue listing', () => {
  test('keeps the general repository view to one bounded GitHub page', async () => {
    const calls: string[] = [];
    const request = (async <Result>(path: string) => {
      calls.push(path);
      return [] as Result;
    }) as typeof requestGitHub;

    await listRepositoryIssues('DotNaos/project-space', 'read-token', request);

    expect(calls).toEqual([
      '/repos/DotNaos/project-space/issues?state=all&per_page=100&sort=updated&direction=desc'
    ]);
  });

  test('loads parent and sub-issue progress in one GraphQL repository query', async () => {
    const requests: Array<{ query: string; variables: Record<string, string>; token: string }> = [];
    const request = (async <Result>(query: string, variables: Record<string, string>, token: string) => {
      requests.push({ query, variables, token });
      return {
        repository: {
          issues: {
            nodes: [
              {
                number: 721,
                parent: null,
                subIssuesSummary: { completed: 2, percentCompleted: 33, total: 6 }
              },
              {
                number: 722,
                parent: {
                  number: 721,
                  repository: { nameWithOwner: 'DotNaos/project-space' },
                  title: 'Make Compute Tailscale-native with client-owned remote development',
                  url: 'https://github.com/DotNaos/project-space/issues/721'
                },
                subIssuesSummary: { completed: 0, percentCompleted: 0, total: 0 }
              }
            ]
          }
        }
      } as Result;
    }) as RequestGitHubGraphQL;

    const hierarchy = await listRepositoryIssueHierarchy('DotNaos/project-space', 'read-token', request);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.variables).toEqual({ name: 'project-space', owner: 'DotNaos' });
    expect(requests[0]?.token).toBe('read-token');
    expect(requests[0]?.query).toContain('subIssuesSummary');
    expect(hierarchy.get(721)?.subIssueProgress).toEqual({
      completed: 2,
      percentCompleted: 33,
      total: 6
    });
    expect(hierarchy.get(722)?.parentIssue).toEqual({
      number: 721,
      repositoryFullName: 'DotNaos/project-space',
      title: 'Make Compute Tailscale-native with client-owned remote development',
      url: 'https://github.com/DotNaos/project-space/issues/721'
    });
  });

  test('does not invent hierarchy metadata for ordinary issues', () => {
    const hierarchy = mapGitHubIssueHierarchy([{
      number: 1,
      parent: null,
      subIssuesSummary: { completed: 0, percentCompleted: 0, total: 0 }
    }]);
    const issue = mapGitHubIssue({
      body: null,
      html_url: 'https://github.com/DotNaos/project-space/issues/1',
      id: 1,
      labels: [],
      number: 1,
      pull_request: undefined,
      state: 'open',
      title: 'Ordinary issue',
      updated_at: null,
      user: null
    }, hierarchy);

    expect(issue.parentIssue).toBeUndefined();
    expect(issue.subIssueProgress).toBeUndefined();
  });
});
