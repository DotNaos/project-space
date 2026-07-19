import { describe, expect, test } from 'bun:test';

import {
  createGitHubBranchWithDependencies,
  updateGitHubIssueWithDependencies
} from '../server/local-github-issue-actions';
import type { requestGitHubGraphQL } from '../server/github-graphql-client';
import type { requestGitHub } from '../server/local-github-catalog';
import type { LocalGitHubApiIssue } from '../server/local-github-issue-creation-remote';
import { gitHubIssueCreationMarker } from '../src/shared/github-issue-creation-marker';

const operationId = '00000000-0000-4000-8000-000000000187';
const marker = gitHubIssueCreationMarker(operationId);

function issue(overrides: Partial<LocalGitHubApiIssue> = {}): LocalGitHubApiIssue {
  return {
    body: `Old description\n\n${marker}`,
    html_url: 'https://github.com/DotNaos/project-space/issues/187',
    id: 9187,
    labels: [],
    number: 187,
    state: 'open',
    title: 'Create issue modal',
    ...overrides
  };
}

describe('local GitHub issue actions', () => {
  test('returns the exact linked branch commit reported by GitHub', async () => {
    const request = (async <Result>(path: string) => {
      if (path === '/repos/DotNaos/project-space') {
        return {
          default_branch: 'main',
          html_url: 'https://github.com/DotNaos/project-space'
        } as Result;
      }
      if (path === '/repos/DotNaos/project-space/git/ref/heads/main') {
        return { object: { sha: 'a'.repeat(40) } } as Result;
      }
      throw new Error('Unexpected GitHub path: ' + path);
    }) as typeof requestGitHub;
    const graphql = (async <Result>(_token: string, query: string) => (
      query.includes('LinkedBranchTarget')
        ? { repository: { issue: { id: 'I_issue' } } }
        : {
            createLinkedBranch: {
              linkedBranch: {
                ref: {
                  name: 'issue-266-dogfood',
                  target: { oid: 'b'.repeat(40) }
                }
              }
            }
          }
    ) as Result) as typeof requestGitHubGraphQL;

    await expect(createGitHubBranchWithDependencies({
      fullName: 'DotNaos/project-space',
      issueNumber: 266,
      name: 'issue-266-dogfood',
      sourceBranch: 'main'
    }, {
      requestGitHub: request,
      requestGitHubGraphQL: graphql,
      resolveOAuthToken: async () => ({ source: 'stored-oauth', token: 'secret-token' })
    })).resolves.toEqual({
      branch: {
        commitSha: 'b'.repeat(40),
        isDefault: false,
        linkedIssueNumbers: [266],
        name: 'issue-266-dogfood',
        url: 'https://github.com/DotNaos/project-space/tree/issue-266-dogfood'
      },
      status: 'connected'
    });
  });

  test('reads the current issue and preserves its creation marker on body edits', async () => {
    const calls: Array<{ body?: string; method?: string; path: string }> = [];
    const request = (async <Result>(path: string, _token: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body ?? ''), method: init?.method, path });
      if (init?.method !== 'PATCH') {
        return issue({ body: `Old description\n\n${marker}\n\nEdited on GitHub` }) as Result;
      }

      const payload = JSON.parse(String(init.body)) as { body: string };
      return issue({ body: payload.body }) as Result;
    }) as typeof requestGitHub;

    const result = await updateGitHubIssueWithDependencies(
      {
        body: 'Updated description',
        fullName: 'DotNaos/project-space',
        number: 187
      },
      {
        requestGitHub: request,
        resolveOAuthToken: async () => ({ source: 'stored-oauth', token: 'secret-token' })
      }
    );

    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: undefined, path: '/repos/DotNaos/project-space/issues/187' },
      { method: 'PATCH', path: '/repos/DotNaos/project-space/issues/187' }
    ]);
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({
      body: `Updated description\n\n${marker}`
    });
    expect(result).toMatchObject({
      issue: { body: 'Updated description', number: 187 },
      status: 'connected'
    });
  });

  test('does not add an extra read for updates without a body', async () => {
    const calls: Array<{ body?: string; method?: string }> = [];
    const request = (async <Result>(_path: string, _token: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body ?? ''), method: init?.method });
      return issue({ labels: [{ name: 'bug' }] }) as Result;
    }) as typeof requestGitHub;

    await updateGitHubIssueWithDependencies(
      { fullName: 'DotNaos/project-space', labels: ['bug'], number: 187 },
      {
        requestGitHub: request,
        resolveOAuthToken: async () => ({ source: 'stored-oauth', token: 'secret-token' })
      }
    );

    expect(calls).toEqual([
      { body: JSON.stringify({ labels: ['bug'] }), method: 'PATCH' }
    ]);
  });
});
