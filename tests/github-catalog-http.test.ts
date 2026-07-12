import { describe, expect, test } from 'bun:test';
import { createProjectSpaceIntegrationApiRoutes } from '../server/project-space-api-integration-routes';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

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
});
