import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createProjectSpaceIntegrationApiRoutes } from '../server/project-space-api-integration-routes';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

function jsonRequest(body: unknown) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  request.headers = { 'content-type': 'application/json' };
  request.method = 'POST';
  return request;
}

function responseRecorder() {
  let body = '';
  let status = 0;
  const headers = new Map<string, string>();
  const response = {
    end(value?: string) { body = value ?? ''; },
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    writeHead(code: number) {
      status = code;
      return response;
    }
  } as unknown as ServerResponse;
  return {
    read: () => ({ body: body ? JSON.parse(body) : undefined, headers, status }),
    response
  };
}

describe('GitHub catalog HTTP contract', () => {
  test('keeps responses private and passes explicit manual refresh semantics', async () => {
    const calls: unknown[] = [];
    const backend = {
      async getGitHubCatalog(options?: { forceRefresh?: boolean }) {
        calls.push(options);
        return { checkedAt: '', repositories: [], status: 'connected' as const };
      }
    } as ProjectSpaceBackend;
    const headers = new Map<string, string>();
    let body = '';
    const response = {
      end(value?: string) { body = value ?? ''; },
      setHeader(name: string, value: string) { headers.set(name, value); },
      writeHead() {}
    } as never;
    const route = createProjectSpaceIntegrationApiRoutes(backend);

    expect(await route({ method: 'GET' } as never, response, new URL('https://test/api/github/catalog?refresh=1'))).toBe(true);
    expect(calls).toEqual([{ forceRefresh: true }]);
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    expect(JSON.parse(body).status).toBe('connected');
  });

  test('keeps workflow detail private and validates the run selector', async () => {
    const calls: unknown[] = [];
    const backend = { async getGitHubWorkflowRunDetail(fullName: string, runId: number) {
      calls.push([fullName, runId]);
      return { checkedAt: '', jobs: [], status: 'connected' as const };
    }} as ProjectSpaceBackend;
    const headers = new Map<string, string>();
    let status = 0;
    const response = {
      end() {}, setHeader(name: string, value: string) { headers.set(name, value); },
      writeHead(value: number) { status = value; }
    } as never;
    const route = createProjectSpaceIntegrationApiRoutes(backend);
    expect(await route({ method: 'GET' } as never, response, new URL('https://test/api/github/workflow-runs/42?fullName=DotNaos%2Fproject-space'))).toBe(true);
    expect(calls).toEqual([['DotNaos/project-space', 42]]);
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    expect(await route({ method: 'GET' } as never, response, new URL('https://test/api/github/workflow-runs/0?fullName=x'))).toBe(true);
    expect(status).toBe(400);
  });

  test('validates and keeps branch comparison responses private', async () => {
    const calls: unknown[] = [];
    const backend = {
      async getGitHubBranchComparison(input: unknown) {
        calls.push(input);
        return {
          checkedAt: '2026-07-30T10:00:00Z',
          commits: [],
          freshness: 'unavailable' as const,
          mergeBaseIncluded: false,
          status: 'error' as const,
          truncated: false
        };
      }
    } as unknown as ProjectSpaceBackend;
    const route = createProjectSpaceIntegrationApiRoutes(backend);
    const valid = responseRecorder();
    const payload = {
      expectedHeadSha: 'a'.repeat(40),
      fullName: 'DotNaos/project-space',
      headBranch: 'issue-473-release-tag-queue-no-conflicts',
      limit: 1
    };

    expect(await route(
      jsonRequest(payload),
      valid.response,
      new URL('https://test/api/github/branch-comparison')
    )).toBe(true);
    expect(valid.read().status).toBe(200);
    expect(valid.read().headers.get('cache-control')).toBe('private, no-store');
    expect(calls).toEqual([payload]);

    const invalid = responseRecorder();
    expect(await route(
      jsonRequest({ ...payload, limit: 50 }),
      invalid.response,
      new URL('https://test/api/github/branch-comparison')
    )).toBe(true);
    expect(invalid.read().status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});
