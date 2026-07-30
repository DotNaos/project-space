import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

const readIteration = mock(() => Promise.resolve({
  action: 'none' as const,
  checkedAt: '2026-07-30T04:00:00.000Z',
  reasonCode: 'repository-unavailable' as const,
  state: 'unavailable' as const
}));
const startIteration = mock(() => Promise.resolve({
  action: 'none' as const,
  checkedAt: '2026-07-30T04:00:00.000Z',
  reasonCode: 'repository-unavailable' as const,
  state: 'unavailable' as const
}));

mock.module('../server/pr-prototype-iteration-configured', () => ({
  createConfiguredPullRequestPrototypeIterationService: () => ({
    read: readIteration,
    start: startIteration
  })
}));
mock.module('../server/pr-test-surfaces/configured-runtime', () => ({
  readConfiguredPullRequestTestSurfaces: async () => ({ surfaces: [] })
}));

const { createPullRequestPrototypeIterationRoute } = await import(
  '../server/pr-prototype-iteration-http'
);

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  readIteration.mockClear();
  startIteration.mockClear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function request(path: string, init?: RequestInit) {
  const route = createPullRequestPrototypeIterationRoute({} as ProjectSpaceBackend);
  const server = createServer(async (incoming, response) => {
    await route(
      incoming,
      response,
      new URL(incoming.url ?? '/', 'http://127.0.0.1'),
      'authenticated-user'
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe('trusted PR prototype iteration HTTP route', () => {
  test('rejects browser-supplied machine, worktree, task, and server identities', async () => {
    const base = '/api/pull-request-previews/prototype-iteration?' +
      'repositoryFullName=DotNaos%2Fproject-space&pullRequestNumber=395&' +
      `headSha=${'a'.repeat(40)}&surface=desktop-prototype`;
    expect((await request(`${base}&machineId=machine-1`)).status).toBe(400);
    expect(readIteration).not.toHaveBeenCalled();

    const response = await request('/api/pull-request-previews/prototype-iteration', {
      body: JSON.stringify({
        headSha: 'a'.repeat(40),
        pullRequestNumber: 395,
        repositoryFullName: 'DotNaos/project-space',
        serverId: 'arbitrary-command',
        surface: 'desktop-prototype',
        taskId: 'thread-1',
        worktreeId: 'worktree-1'
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(response.status).toBe(400);
    expect(startIteration).not.toHaveBeenCalled();
  });
});
