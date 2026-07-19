import { describe, expect, test } from 'bun:test';

import {
  GitHubRequestError,
  mapGitHubIssue,
  type requestGitHub
} from '../server/local-github-catalog';
import {
  createLocalGitHubIssueCreationRemote,
  type LocalGitHubApiIssue
} from '../server/local-github-issue-creation-remote';
import { gitHubIssueCreationMarker } from '../server/github-issue-creation-service';

const operationId = '00000000-0000-4000-8000-000000000187';
const marker = gitHubIssueCreationMarker(operationId);

function apiIssue(overrides: Partial<LocalGitHubApiIssue> = {}): LocalGitHubApiIssue {
  return {
    body: `Description\n\n${marker}`,
    html_url: 'https://github.com/DotNaos/project-space/issues/187',
    id: 9187,
    labels: [{ name: 'bug' }],
    number: 187,
    state: 'open',
    title: 'Create issue modal',
    ...overrides
  };
}

describe('local GitHub issue creation remote', () => {
  test('posts the marker body and removes it from the returned issue', async () => {
    const calls: Array<{ init?: RequestInit; path: string; token: string }> = [];
    const request = (async <Result>(path: string, token: string, init?: RequestInit) => {
      calls.push({ init, path, token });
      return apiIssue() as Result;
    }) as typeof requestGitHub;
    const remote = createLocalGitHubIssueCreationRemote('secret-token', request);

    const result = await remote.create({
      body: `Description\n\n${marker}`,
      fullName: 'DotNaos/project-space',
      labels: ['bug'],
      operationId,
      title: 'Create issue modal'
    });

    expect(result.body).toBe('Description');
    expect(result.id).toBe(9187);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: '/repos/DotNaos/project-space/issues',
      token: 'secret-token'
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      body: `Description\n\n${marker}`,
      labels: ['bug'],
      title: 'Create issue modal'
    });
  });

  test('reconciles exact issue markers and excludes pull requests', async () => {
    const request = (async <Result>() => [
      apiIssue(),
      apiIssue({ number: 188, pull_request: {} }),
      apiIssue({ body: 'A different issue', number: 189 })
    ] as Result) as typeof requestGitHub;
    const remote = createLocalGitHubIssueCreationRemote('secret-token', request);

    expect(await remote.findByMarker('DotNaos/project-space', marker)).toEqual([
      expect.objectContaining({ body: 'Description', number: 187 })
    ]);
  });

  test('searches exact issue bodies after five full recent pages', async () => {
    const calls: string[] = [];
    const request = (async <Result>(path: string) => {
      calls.push(path);
      if (path.startsWith('/search/issues?')) {
        return {
          items: [
            apiIssue({ number: 77 }),
            apiIssue({ number: 78, pull_request: {} }),
            apiIssue({ body: 'Search matched a comment, not the body.', number: 79 })
          ]
        } as Result;
      }

      const page = Number(new URL(path, 'https://api.github.test').searchParams.get('page'));
      return Array.from({ length: 100 }, (_, index) => apiIssue({
        body: 'A recent issue without the marker.',
        number: page * 1_000 + index
      })) as Result;
    }) as typeof requestGitHub;
    const remote = createLocalGitHubIssueCreationRemote('secret-token', request);

    expect(await remote.findByMarker('DotNaos/project-space', marker)).toEqual([
      expect.objectContaining({ body: 'Description', number: 77 })
    ]);
    expect(calls).toHaveLength(6);
    const searchUrl = new URL(calls[5], 'https://api.github.test');
    expect(searchUrl.pathname).toBe('/search/issues');
    expect(searchUrl.searchParams.get('q')).toBe(
      `repo:DotNaos/project-space is:issue in:body "${marker}"`
    );
    expect(searchUrl.searchParams.get('per_page')).toBe('100');
  });

  test('deduplicates a recent match returned again by marker search', async () => {
    const request = (async <Result>(path: string) => {
      if (path.startsWith('/search/issues?')) {
        return {
          items: [apiIssue({ number: 187 }), apiIssue({ number: 87 })]
        } as Result;
      }

      const page = Number(new URL(path, 'https://api.github.test').searchParams.get('page'));
      return Array.from({ length: 100 }, (_, index) => apiIssue({
        body: page === 1 && index === 0 ? `Description\n\n${marker}` : 'No marker.',
        number: page === 1 && index === 0 ? 187 : page * 1_000 + index
      })) as Result;
    }) as typeof requestGitHub;
    const remote = createLocalGitHubIssueCreationRemote('secret-token', request);

    expect((await remote.findByMarker('DotNaos/project-space', marker)).map(
      (issue) => issue.number
    )).toEqual([187, 87]);
  });

  test('removes the hidden marker from repository catalog issues', () => {
    expect(mapGitHubIssue(apiIssue())).toMatchObject({
      body: 'Description',
      number: 187
    });
    expect(mapGitHubIssue(apiIssue({ body: marker })).body).toBeUndefined();
  });

  test('only treats definitive GitHub rejections as safe to retry', () => {
    const remote = createLocalGitHubIssueCreationRemote('secret-token');
    expect(remote.isRetrySafeError(new GitHubRequestError(422, false))).toBe(true);
    expect(remote.isRetrySafeError(new GitHubRequestError(500, false))).toBe(false);
    expect(remote.isRetrySafeError(new Error('network timeout'))).toBe(false);
  });
});
