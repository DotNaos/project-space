import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { PullRequestTestSurfacesResult } from '../src/shared/pr-preview-test-surfaces-api';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

const result: PullRequestTestSurfacesResult = {
  checkedAt: '2026-07-27T12:00:00.000Z',
  feedback: { reasonCode: 'feedback-not-live', state: 'unavailable' },
  headSha: 'a'.repeat(40),
  liveContext: {
    reasonCode: 'live-registration-missing',
    state: 'unavailable'
  },
  pullRequestNumber: 356,
  repositoryFullName: 'DotNaos/project-space',
  surfaces: [
    {
      commitSha: 'a'.repeat(40),
      kind: 'desktop-prototype',
      source: 'deployed',
      state: 'available',
      url: 'https://pr-356.projects.os-home.net/prototype/desktop/',
      verifiedAt: '2026-07-27T12:00:00.000Z'
    }
  ]
};

mock.module('../server/pr-test-surfaces/configured-runtime', () => ({
  PullRequestFeedbackUnavailableError: class extends Error {},
  readConfiguredPullRequestTestSurfaces: async () => result,
  sendConfiguredPullRequestPrototypeFeedback: async () => ({
    state: 'sent',
    threadId: '019fa450-5e20-7222-b2c7-fb81fdba589d'
  })
}));

const { createPullRequestTestSurfacesTrustedRoute } = await import(
  '../server/pr-test-surfaces/trusted-http'
);

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function request(path: string, init?: RequestInit) {
  const route = createPullRequestTestSurfacesTrustedRoute({} as ProjectSpaceBackend);
  const server = createServer(async (incoming, response) => {
    await route(
      incoming,
      response,
      new URL(incoming.url ?? '/', 'http://127.0.0.1'),
      'user-1'
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe('trusted PR test-surface HTTP route', () => {
  test('returns the typed surface contract only for exact selectors', async () => {
    const response = await request(
      '/api/pull-request-previews/test-surfaces?repositoryFullName=DotNaos%2Fproject-space&pullRequestNumber=356'
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    expect((await request(
      '/api/pull-request-previews/test-surfaces?repositoryFullName=DotNaos%2Fproject-space'
    )).status).toBe(400);
  });

  test('keeps feedback on the trusted route and returns only the verified task id', async () => {
    const response = await request('/api/pull-request-previews/feedback', {
      body: JSON.stringify({
        comment: 'The empty state needs more space.',
        pullRequestNumber: 356,
        repositoryFullName: 'DotNaos/project-space',
        scenario: 'empty',
        surface: 'mobile-prototype',
        viewport: 'phone'
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: 'sent',
      threadId: '019fa450-5e20-7222-b2c7-fb81fdba589d'
    });
  });
});
