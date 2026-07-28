import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { GitHubRequestError } from '../server/local-github-catalog';
import { getCurrentAuthSession } from '../server/local-auth-store';
import {
  createRoadmapCliHttpApi,
  type RoadmapCliHttpService
} from '../server/roadmap/roadmap-cli-http';
import { createConfiguredRoadmapCliHandler } from '../server/roadmap/roadmap-cli-runtime';
import type { RoadmapResult } from '../src/shared/roadmap-api';

const servers: Server[] = [];
const repository = 'DotNaos/project-space';

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function result(options: Partial<RoadmapResult> = {}): RoadmapResult {
  const first = {
    availability: 'closed' as const,
    description: '# First description',
    issue: { fullName: repository, id: 1, number: 1 },
    labels: [],
    state: 'closed' as const,
    title: 'First'
  };
  const second = {
    availability: 'ready' as const,
    description: '',
    issue: { fullName: repository, id: 2, number: 2 },
    labels: [],
    state: 'open' as const,
    title: 'Second'
  };
  return {
    availableIssues: [
      {
        description: '# First description',
        issue: first.issue,
        state: 'closed' as const,
        title: first.title
      },
      {
        description: '',
        issue: second.issue,
        state: 'open' as const,
        title: second.title
      },
      {
        description: 'Searchable unplanned issue',
        issue: { fullName: repository, id: 7, number: 7 },
        state: 'open' as const,
        title: 'Seventh'
      }
    ],
    canEdit: true,
    checkedAt: '2026-07-27T00:00:00.000Z',
    dependencies: [{ blocked: second.issue, blocker: first.issue, freshness: 'current' }],
    dependencySync: 'current',
    graphRevision: '12345678',
    issues: [first, second],
    plan: {
      goals: [],
      items: [
        { issue: first.issue, plannedState: 'planned' },
        { issue: second.issue, plannedState: 'planned' }
      ],
      revision: 2
    },
    repository: { fullName: repository, id: 42 },
    status: 'connected',
    ...options
  };
}

async function start(handler: (
  request: Parameters<ReturnType<typeof createRoadmapCliHttpApi>>[0],
  response: Parameters<ReturnType<typeof createRoadmapCliHttpApi>>[1],
  url: URL
) => Promise<boolean>) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address.');
  return `http://127.0.0.1:${address.port}`;
}

function stub() {
  const calls: Array<{ actor: unknown; kind: string; value: unknown }> = [];
  const service: RoadmapCliHttpService = {
    async add(actor, request) {
      calls.push({ actor, kind: 'add', value: request });
      return result();
    },
    async get(actor, fullName) {
      calls.push({ actor, kind: 'get', value: fullName });
      return result();
    },
    async remove(actor, request) {
      calls.push({ actor, kind: 'remove', value: request });
      return result();
    }
  };
  return { calls, service };
}

describe('roadmap CLI HTTP boundary', () => {
  test('returns the authoritative graph and dispatches add and remove', async () => {
    const { calls, service } = stub();
    const origin = await start(createRoadmapCliHttpApi(
      service,
      async () => ({ userId: 'owner' })
    ));
    const read = await fetch(`${origin}/api/roadmap?fullName=${encodeURIComponent(repository)}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      dependencyFreshness: 'current',
      edges: [{
        from: { number: 1, repository },
        satisfied: true,
        to: { number: 2, repository }
      }],
      graphRevision: '12345678',
      issues: [
        {
          description: '# First description',
          number: 1,
          repository,
          title: 'First'
        },
        {
          description: '',
          number: 2,
          repository,
          title: 'Second'
        },
        {
          description: 'Searchable unplanned issue',
          number: 7,
          repository,
          title: 'Seventh'
        }
      ],
      nodes: [
        {
          description: '# First description',
          number: 1,
          repository,
          state: 'DONE',
          title: 'First'
        },
        {
          description: '',
          number: 2,
          repository,
          state: 'READY',
          title: 'Second'
        }
      ],
      paths: [[
        { number: 1, repository },
        { number: 2, repository }
      ]],
      repository
    });

    const mutation = {
      blockedIssueNumber: 2,
      blocker: { fullName: repository, issueNumber: 1 },
      expectedGraphRevision: '12345678',
      fullName: repository
    };
    for (const method of ['POST', 'DELETE']) {
      const response = await fetch(`${origin}/api/roadmap/dependencies`, {
        body: JSON.stringify(mutation),
        headers: { 'Content-Type': 'application/json' },
        method
      });
      expect(response.status).toBe(200);
    }
    expect(calls.map(({ kind }) => kind)).toEqual(['get', 'add', 'remove']);
    expect(calls[1]).toEqual({ actor: { userId: 'owner' }, kind: 'add', value: mutation });
  });

  test('rejects issue descriptions that exceed the graph response budget', async () => {
    const { service } = stub();
    service.get = async () => result({
      availableIssues: [{
        description: 'x'.repeat((4 << 20) + 1),
        issue: { fullName: repository, id: 1, number: 1 },
        state: 'open',
        title: 'Oversized'
      }]
    });
    const origin = await start(createRoadmapCliHttpApi(
      service,
      async () => ({ userId: 'owner' })
    ));
    const response = await fetch(
      `${origin}/api/roadmap?fullName=${encodeURIComponent(repository)}`
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'roadmap_too_large' }
    });
  });

  test('rejects malformed requests before dispatch', async () => {
    const { calls, service } = stub();
    const origin = await start(createRoadmapCliHttpApi(
      service,
      async () => ({ userId: 'owner' })
    ));
    for (const [path, options] of [
      ['/api/roadmap?fullName=a%2Fb&fullName=c%2Fd', undefined],
      ['/api/roadmap?repository=a%2Fb', undefined],
      ['/api/roadmap/dependencies', {
        body: JSON.stringify({
          blockedIssueNumber: 0,
          blocker: { fullName: repository, issueNumber: 1 },
          expectedGraphRevision: 'wrong',
          fullName: repository
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      }]
    ] as const) {
      const response = await fetch(`${origin}${path}`, options);
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test('reports stale, cycle, permission and revision conflicts clearly', async () => {
    for (const [failure, status, code] of [
      [new Error('Refresh GitHub dependencies before editing the roadmap.'), 409, 'stale_dependencies'],
      [new Error('This dependency would create a cycle.'), 409, 'dependency_cycle'],
      [new Error('You do not have permission to edit this roadmap.'), 403, 'permission_denied']
    ] as const) {
      const { service } = stub();
      service.add = async () => { throw failure; };
      const origin = await start(createRoadmapCliHttpApi(
        service,
        async () => ({ userId: 'owner' })
      ));
      const response = await fetch(`${origin}/api/roadmap/dependencies`, {
        body: JSON.stringify({
          blockedIssueNumber: 2,
          blocker: { fullName: repository, issueNumber: 1 },
          expectedGraphRevision: '12345678',
          fullName: repository
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }

    const { service } = stub();
    service.add = async () => result({
      conflict: 'dependencies',
      message: 'Dependencies changed. Review the latest roadmap before editing.'
    });
    const origin = await start(createRoadmapCliHttpApi(
      service,
      async () => ({ userId: 'owner' })
    ));
    const response = await fetch(`${origin}/api/roadmap/dependencies`, {
      body: JSON.stringify({
        blockedIssueNumber: 2,
        blocker: { fullName: repository, issueNumber: 1 },
        expectedGraphRevision: '12345678',
        fullName: repository
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'revision_conflict' }
    });
  });

  test('distinguishes expired GitHub auth, rate limits, and permissions', async () => {
    for (const [failure, status, code] of [
      [new GitHubRequestError(401, false), 401, 'github_auth_required'],
      [new GitHubRequestError(403, true), 429, 'github_rate_limited'],
      [new GitHubRequestError(403, false), 403, 'github_permission_denied']
    ] as const) {
      const { service } = stub();
      service.add = async () => { throw failure; };
      const origin = await start(createRoadmapCliHttpApi(
        service,
        async () => ({ userId: 'owner' })
      ));
      const response = await fetch(`${origin}/api/roadmap/dependencies`, {
        body: JSON.stringify({
          blockedIssueNumber: 2,
          blocker: { fullName: repository, issueNumber: 1 },
          expectedGraphRevision: '12345678',
          fullName: repository
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });

  test('binds a connected machine to its owning user GitHub session', async () => {
    let sessionUser = '';
    const handler = createConfiguredRoadmapCliHandler({
      backend: {
        async addRoadmapDependency() { return result(); },
        async getRoadmap() {
          sessionUser = getCurrentAuthSession()?.userId ?? '';
          return result();
        },
        async removeRoadmapDependency() { return result(); }
      },
      machineConnection: {
        async resolveMachineCredentialIdentity(token, machineId) {
          return token === 'machine-token' && machineId === 'machine-one'
            ? { machineId, userId: 'owner-user' }
            : null;
        }
      }
    });
    const origin = await start(handler);
    const response = await fetch(
      `${origin}/api/roadmap?fullName=${encodeURIComponent(repository)}`,
      {
        headers: {
          Authorization: 'Bearer machine-token',
          'X-Project-Machine-ID': 'machine-one'
        }
      }
    );
    expect(response.status).toBe(200);
    expect(sessionUser).toBe('owner-user');
  });
});
