import { describe, expect, test } from 'bun:test';
import type { ServerResponse } from 'node:http';
import { createProjectSpaceCoreApiRoutes } from '../server/project-space-api-core-routes';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

const headSha = 'a'.repeat(40);

function responseRecorder() {
  let body = '';
  let status = 0;
  const headers = new Map<string, string>();
  const response = {
    end(value?: string) { body = value ?? ''; },
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    writeHead(code: number) { status = code; return response; }
  } as unknown as ServerResponse;
  return { read: () => ({ body: body ? JSON.parse(body) : undefined, headers, status }), response };
}

function connectedBackend() {
  return {
    async getGitHubRepositoryDetails() {
      return {
        branches: [],
        checkedAt: '2026-07-22T10:00:00.000Z',
        issues: [],
        pullRequests: [{
          headBranch: 'issue-263-preview',
          headSha,
          number: 263,
          state: 'open' as const,
          title: 'Preview deployments',
          url: 'https://github.com/DotNaos/project-space/pull/263'
        }],
        status: 'connected' as const
      };
    }
  } as ProjectSpaceBackend;
}

describe('pull request Preview HTTP contract', () => {
  test('is private, repository-gated, sanitized, and correlated with current GitHub evidence', async () => {
    const calls: Array<[string, number | undefined]> = [];
    const route = createProjectSpaceCoreApiRoutes(connectedBackend(), {
      loadPullRequestPreviewStatus: async (repository, number) => {
        calls.push([repository, number]);
        return {
          checkedAt: '2026-07-22T10:01:00.000Z',
          previews: [{
            liveUrl: 'https://pr-263.projects.os-home.net/',
            liveUrlState: 'available',
            pullRequestNumber: 263,
            repositoryFullName: repository,
            requestedSha: headSha,
            runningSha: headSha,
            state: 'ready'
          }],
          repositoryFullName: repository,
          status: 'available'
        };
      }
    });
    const output = responseRecorder();
    const handled = await route(
      { method: 'GET' } as never,
      output.response,
      new URL('https://test/api/pull-request-previews/status?repositoryFullName=DotNaos%2Fproject-space&pullRequestNumber=263'),
      'user-1'
    );

    expect(handled).toBe(true);
    expect(calls).toEqual([['DotNaos/project-space', 263]]);
    expect(output.read().headers.get('cache-control')).toBe('private, no-store');
    expect(output.read().body.previews[0]).toMatchObject({
      currentHeadSha: headSha,
      pullRequestState: 'open',
      pullRequestTitle: 'Preview deployments'
    });
  });

  test('rejects ambiguous selectors before invoking the status loader', async () => {
    let called = false;
    const route = createProjectSpaceCoreApiRoutes(connectedBackend(), {
      loadPullRequestPreviewStatus: async () => {
        called = true;
        throw new Error('must not run');
      }
    });
    for (const url of [
      'https://test/api/pull-request-previews/status?repositoryFullName=DotNaos%2Fproject-space&pullRequestNumber=0',
      'https://test/api/pull-request-previews/status?repositoryFullName=a%2Fb&repositoryFullName=c%2Fd',
      'https://test/api/pull-request-previews/status?repositoryFullName=DotNaos%2Fproject-space&secret=1'
    ]) {
      const output = responseRecorder();
      await route({ method: 'GET' } as never, output.response, new URL(url), 'user-1');
      expect(output.read().status).toBe(400);
      expect(output.read().headers.get('cache-control')).toBe('private, no-store');
    }
    expect(called).toBe(false);
  });

  test('returns unauthorized without reading the registry when repository access is absent', async () => {
    let called = false;
    const backend = {
      async getGitHubRepositoryDetails() {
        return { branches: [], checkedAt: '', issues: [], pullRequests: [], status: 'not-connected' as const };
      }
    } as ProjectSpaceBackend;
    const route = createProjectSpaceCoreApiRoutes(backend, {
      loadPullRequestPreviewStatus: async () => {
        called = true;
        throw new Error('must not run');
      }
    });
    const output = responseRecorder();
    await route(
      { method: 'GET' } as never,
      output.response,
      new URL('https://test/api/pull-request-previews/status?repositoryFullName=someone%2Fprivate'),
      'user-1'
    );
    expect(output.read().body).toMatchObject({ previews: [], status: 'unauthorized' });
    expect(called).toBe(false);
  });
});
