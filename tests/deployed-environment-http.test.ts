import { describe, expect, test } from 'bun:test';
import { createProjectSpaceCoreApiRoutes } from '../server/project-space-api-core-routes';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

describe('deployed environment HTTP contract', () => {
  test('is GET-only, private, and forwards only the repository selector', async () => {
    const calls: string[] = [];
    const backend = { async getDeployedEnvironmentStatus(repository: string) {
      calls.push(repository);
      return { checkedAt: '', environments: [], repositoryFullName: repository, status: 'available' as const };
    }} as ProjectSpaceBackend;
    const headers = new Map<string, string>();
    let body = '';
    const response = { end(value?: string) { body = value ?? ''; }, setHeader(name: string, value: string) { headers.set(name, value); }, writeHead() {} } as never;
    const route = createProjectSpaceCoreApiRoutes(backend);
    expect(await route({ method: 'GET' } as never, response, new URL('https://test/api/deployed-environments/status?repositoryFullName=DotNaos%2Fproject-space'), 'user')).toBe(true);
    expect(calls).toEqual(['DotNaos/project-space']);
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    expect(JSON.parse(body)).toEqual({ checkedAt: '', environments: [], repositoryFullName: 'DotNaos/project-space', status: 'available' });
  });
});
