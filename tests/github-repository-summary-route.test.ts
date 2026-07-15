import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { createGitHubRepositorySummaryRoute } from '../server/github-repository-summary-route';
import { createProjectSpaceIntegrationApiRoutes } from '../server/project-space-api-integration-routes';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

function request(method: string) {
  const value = Readable.from([]) as IncomingMessage;
  value.method = method;
  value.headers = {};
  return value;
}

function responseRecorder() {
  let body = '';
  let status = 0;
  const headers = new Map<string, string>();
  const response = {
    end(value?: string) {
      body = value ?? '';
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    writeHead(code: number, values?: Record<string, string>) {
      status = code;
      for (const [name, value] of Object.entries(values ?? {})) {
        headers.set(name.toLowerCase(), value);
      }
      return response;
    }
  } as unknown as ServerResponse;

  return {
    read: () => ({ body: body ? JSON.parse(body) : undefined, headers, status }),
    response
  };
}

describe('GitHub repository summary route', () => {
  test('returns only the requested scoped counts without caching', async () => {
    const output = responseRecorder();
    const route = createGitHubRepositorySummaryRoute({
      async loadSummary(fullName) {
        return {
          branchCount: 42,
          checkedAt: '2026-07-14T00:00:00.000Z',
          fullName,
          openIssueCount: 147,
          status: 'connected'
        };
      }
    });
    const handled = await route(
      request('GET'),
      output.response,
      new URL('http://project.test/api/github/repository-summary?fullName=DotNaos%2Fproject-space')
    );

    expect(handled).toBe(true);
    expect(output.read()).toMatchObject({
      body: { branchCount: 42, fullName: 'DotNaos/project-space', openIssueCount: 147 },
      status: 200
    });
    expect(output.read().headers.get('cache-control')).toBe('private, no-store');
  });

  test('is registered inside the authenticated integration router', async () => {
    const output = responseRecorder();
    const route = createProjectSpaceIntegrationApiRoutes({} as ProjectSpaceBackend, {
      async loadGitHubRepositorySummary(fullName) {
        return {
          branchCount: 63,
          checkedAt: '2026-07-14T00:00:00.000Z',
          fullName,
          openIssueCount: 147,
          status: 'connected'
        };
      }
    });

    expect(await route(
      request('GET'),
      output.response,
      new URL('http://project.test/api/github/repository-summary?fullName=DotNaos%2Fproject-space')
    )).toBe(true);
    expect(output.read()).toMatchObject({
      body: { branchCount: 63, openIssueCount: 147 },
      status: 200
    });
  });

  test('rejects missing, duplicate, or extra repository selectors', async () => {
    const route = createGitHubRepositorySummaryRoute();
    for (const url of [
      'http://project.test/api/github/repository-summary',
      'http://project.test/api/github/repository-summary?fullName=a%2Fb&fullName=c%2Fd',
      'http://project.test/api/github/repository-summary?fullName=a%2Fb&other=1'
    ]) {
      const output = responseRecorder();
      expect(await route(request('GET'), output.response, new URL(url))).toBe(true);
      expect(output.read().status).toBe(400);
    }
  });
});
