import { describe, expect, test } from 'bun:test';

import {
  isValidGitHubRepositoryFullName,
  loadLocalGitHubIssueMetadata
} from '../server/local-github-issue-metadata';
import { createProjectSpaceIntegrationApiRoutes } from '../server/project-space-api-integration-routes';
import { loadGitHubIssueMetadata } from '../src/api/github-issue-metadata-client';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

describe('local GitHub issue metadata', () => {
  test('loads every repository label page with the server-held token', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      color: '123abc',
      description: index === 0 ? 'First label' : null,
      name: `label-${index}`
    }));
    const calls: Array<[string, string]> = [];
    const result = await loadLocalGitHubIssueMetadata('DotNaos/project-space', {
      getGitHubClientId: () => 'client-id',
      async requestGitHub<T>(path: string, token: string) {
        calls.push([path, token]);
        return (calls.length === 1
          ? firstPage
          : [{ color: 'fedcba', description: null, name: 'last-label' }]) as T;
      },
      async resolveOAuthToken() { return { token: 'server-only-token' }; }
    });

    expect(calls).toEqual([
      ['/repos/DotNaos/project-space/labels?per_page=100&page=1', 'server-only-token'],
      ['/repos/DotNaos/project-space/labels?per_page=100&page=2', 'server-only-token']
    ]);
    expect(result).toEqual({
      fullName: 'DotNaos/project-space',
      labels: [
        ...firstPage.map((label) => ({
          color: label.color,
          description: label.description ?? undefined,
          name: label.name
        })),
        { color: 'fedcba', description: undefined, name: 'last-label' }
      ],
      status: 'connected'
    });
  });

  test('reports authentication and configuration states without making a GitHub request', async () => {
    let requestCount = 0;
    const dependencies = (clientId: string) => ({
      getGitHubClientId: () => clientId,
      async requestGitHub<T>() { requestCount += 1; return [] as T; },
      async resolveOAuthToken() { return null; }
    });

    expect((await loadLocalGitHubIssueMetadata('DotNaos/project-space', dependencies('configured'))).status)
      .toBe('auth-required');
    expect((await loadLocalGitHubIssueMetadata('DotNaos/project-space', dependencies(''))).status)
      .toBe('not-configured');
    expect(requestCount).toBe(0);
  });

  test('validates repository scope before resolving credentials and returns request failures explicitly', async () => {
    expect(isValidGitHubRepositoryFullName('DotNaos/project-space')).toBe(true);
    expect(isValidGitHubRepositoryFullName('../secret')).toBe(false);
    expect(isValidGitHubRepositoryFullName('owner/repo/extra')).toBe(false);

    let authCount = 0;
    const invalid = await loadLocalGitHubIssueMetadata('../secret', {
      getGitHubClientId: () => 'configured',
      async requestGitHub<T>() { return [] as T; },
      async resolveOAuthToken() { authCount += 1; return { token: 'unused' }; }
    });
    expect(invalid.status).toBe('error');
    expect(authCount).toBe(0);

    const failed = await loadLocalGitHubIssueMetadata('DotNaos/project-space', {
      getGitHubClientId: () => 'configured',
      async requestGitHub() { throw new Error('GitHub request failed with 503.'); },
      async resolveOAuthToken() { return { token: 'server-only-token' }; }
    });
    expect(failed).toEqual({
      fullName: 'DotNaos/project-space',
      labels: [],
      message: 'GitHub request failed with 503.',
      status: 'error'
    });
  });
});

describe('GitHub issue metadata HTTP contract', () => {
  test('keeps responses private, validates fullName, and preserves repository scope', async () => {
    const calls: string[] = [];
    const backend = {} as ProjectSpaceBackend;
    const headers = new Map<string, string>();
    let body = '';
    let status = 0;
    const response = {
      end(value?: string) { body = value ?? ''; },
      setHeader(name: string, value: string) { headers.set(name, value); },
      writeHead(value: number) { status = value; }
    } as never;
    const route = createProjectSpaceIntegrationApiRoutes(backend, {
      async loadGitHubIssueMetadata(fullName) {
        calls.push(fullName);
        return { fullName, labels: [], status: 'connected' };
      }
    });

    expect(await route(
      { method: 'GET' } as never,
      response,
      new URL('https://test/api/github/issue-metadata?fullName=DotNaos%2Fproject-space')
    )).toBe(true);
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    expect(calls).toEqual(['DotNaos/project-space']);
    expect(JSON.parse(body)).toEqual({
      fullName: 'DotNaos/project-space',
      labels: [],
      status: 'connected'
    });

    expect(await route(
      { method: 'GET' } as never,
      response,
      new URL('https://test/api/github/issue-metadata?fullName=..%2Fsecret')
    )).toBe(true);
    expect(status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});

describe('GitHub issue metadata browser client', () => {
  test('uses Project Space authentication and returns repository-scoped labels', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const result = await loadGitHubIssueMetadata('DotNaos/project-space', {
      apiBaseUrl: 'http://127.0.0.1:45873',
      currentHref: 'http://localhost:5173/projects',
      async fetchImplementation(input, init) {
        requestUrl = input.toString();
        requestInit = init;
        return Response.json({
          fullName: 'DotNaos/project-space',
          labels: [{ color: '123abc', description: 'Needs work', name: 'bug' }],
          status: 'connected'
        });
      },
      getAuthToken: () => 'project-space-session'
    });

    expect(requestUrl).toBe(
      'http://127.0.0.1:45873/api/github/issue-metadata?fullName=DotNaos%2Fproject-space'
    );
    expect(new Headers(requestInit?.headers).get('Authorization'))
      .toBe('Bearer project-space-session');
    expect(result.fullName).toBe('DotNaos/project-space');
    expect(result.labels[0]?.description).toBe('Needs work');
  });

  test('rejects responses for a different repository', async () => {
    await expect(loadGitHubIssueMetadata('DotNaos/project-space', {
      currentHref: 'https://projects.os-home.net/projects',
      async fetchImplementation() {
        return Response.json({
          fullName: 'DotNaos/other',
          labels: [],
          status: 'connected'
        });
      },
      getAuthToken: () => null
    })).rejects.toThrow('different repository');
  });
});
