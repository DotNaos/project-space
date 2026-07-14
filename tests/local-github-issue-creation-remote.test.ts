import { describe, expect, test } from 'bun:test';

import { GitHubRequestError, type requestGitHub } from '../server/local-github-catalog';
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

  test('only treats definitive GitHub rejections as safe to retry', () => {
    const remote = createLocalGitHubIssueCreationRemote('secret-token');
    expect(remote.isRetrySafeError(new GitHubRequestError(422, false))).toBe(true);
    expect(remote.isRetrySafeError(new GitHubRequestError(500, false))).toBe(false);
    expect(remote.isRetrySafeError(new Error('network timeout'))).toBe(false);
  });
});
