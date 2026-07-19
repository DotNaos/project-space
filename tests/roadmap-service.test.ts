import { describe, expect, test } from 'bun:test';

import { GitHubRequestError } from '../server/local-github-catalog';
import {
  RoadmapService,
  type RoadmapServiceDependencies
} from '../server/roadmap/roadmap-service';
import { InMemoryRoadmapPlanStore } from '../server/roadmap/roadmap-store';
import type { RoadmapPlanItem } from '../src/shared/roadmap-api';

const fullName = 'DotNaos/project-space';
const repo = {
  full_name: fullName,
  id: 42,
  permissions: { push: true }
};
const issue = (number: number, options: { id?: number; state?: 'open' | 'closed'; title?: string } = {}) => ({
  html_url: `https://github.com/${fullName}/issues/${number}`,
  id: options.id ?? number,
  labels: [],
  number,
  repository_url: `https://api.github.com/repos/${fullName}`,
  state: options.state ?? 'open',
  title: options.title ?? `Issue ${number}`,
  updated_at: '2026-07-19T00:00:00.000Z'
});
const planItem = (number: number): RoadmapPlanItem => ({
  issue: { fullName, id: number, number },
  plannedState: 'planned'
});

function dependencies(
  store: InMemoryRoadmapPlanStore,
  request: RoadmapServiceDependencies['requestGitHub'],
  options: { oauth?: boolean; principal?: string; token?: boolean } = {}
): RoadmapServiceDependencies {
  return {
    dependencyPrincipal: () => options.principal ?? 'alice',
    getGitHubClientId: () => 'client-id',
    getStore: async () => store,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    requestGitHub: request,
    resolveOAuthToken: async () => options.oauth === false ? null : { token: 'oauth-token' },
    resolveToken: async () => options.token === false ? null : { token: 'read-token' }
  };
}

function repositoryRouter(
  issues: ReturnType<typeof issue>[],
  blockedBy: Record<number, ReturnType<typeof issue>[] | Error> = {},
  calls: Array<{ init?: RequestInit; path: string }> = []
): RoadmapServiceDependencies['requestGitHub'] {
  return async <T>(path: string, _token: string, init?: RequestInit) => {
    calls.push({ init, path });
    if (path === '/repos/DotNaos/project-space') return repo as T;
    if (path.startsWith('/repos/DotNaos/project-space/issues?')) return issues as T;
    if (init?.method === 'POST' && path.endsWith('/dependencies/blocked_by')) return {} as T;
    const dependencyMatch = path.match(/issues\/(\d+)\/dependencies\/blocked_by\?per_page=100&page=(\d+)/);
    if (dependencyMatch?.[1]) {
      const result = blockedBy[Number(dependencyMatch[1])] ?? [];
      if (result instanceof Error) throw result;
      return (Number(dependencyMatch[2]) === 1 ? result : []) as T;
    }
    const issueMatch = path.match(/\/issues\/(\d+)$/);
    if (issueMatch?.[1]) {
      const found = issues.find((entry) => entry.number === Number(issueMatch[1]));
      if (found) return found as T;
      throw new GitHubRequestError(404, false);
    }
    throw new Error(`Unexpected GitHub request: ${path}`);
  };
}

describe('roadmap service', () => {
  test('returns an explicit authentication state without GitHub access', async () => {
    const store = new InMemoryRoadmapPlanStore();
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter([]),
      { token: false }
    ));
    expect(await service.get(fullName)).toMatchObject({
      canEdit: false,
      status: 'auth-required'
    });
  });

  test('derives ready, blocked and closed state from current GitHub dependencies', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1), planItem(2), planItem(3)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter(
        [issue(1), issue(2), issue(3, { state: 'closed' })],
        { 2: [issue(1)] }
      )
    ));
    const result = await service.get(fullName);
    expect(result.dependencySync).toBe('current');
    expect(result.issues.map((entry) => [entry.issue.number, entry.availability])).toEqual([
      [1, 'ready'],
      [2, 'blocked'],
      [3, 'closed']
    ]);
  });

  test('marks a failed dependency refresh stale even with no cached edge', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter([issue(1)], { 1: new GitHubRequestError(503, false) })
    ));
    const result = await service.get(fullName);
    expect(result.dependencySync).toBe('stale');
    expect(result.issues[0]?.availability).toBe('stale');
    await expect(service.updatePlan({
      expectedGraphRevision: result.graphRevision,
      expectedRevision: result.plan.revision,
      fullName,
      goals: [],
      items: [{ issueNumber: 1, plannedState: 'active' }]
    })).rejects.toThrow('Refresh GitHub dependencies');
  });

  test('allows a stale missing issue to be removed from the plan', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1), planItem(2)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter(
        [issue(1)],
        { 2: new GitHubRequestError(404, false) }
      )
    ));
    const stale = await service.get(fullName);
    expect(stale.dependencySync).toBe('stale');
    expect(stale.issues.find((entry) => entry.issue.number === 2)?.availability).toBe('missing');

    const saved = await service.updatePlan({
      expectedGraphRevision: stale.graphRevision,
      expectedRevision: stale.plan.revision,
      fullName,
      goals: [],
      items: [{ issueNumber: 1, plannedState: 'planned' }]
    });

    expect(saved.dependencySync).toBe('current');
    expect(saved.plan.items.map((entry) => entry.issue.number)).toEqual([1]);
  });

  test('persists canonical plan identity and reports revision conflicts', async () => {
    const store = new InMemoryRoadmapPlanStore();
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter([issue(1, { id: 901 }), issue(2, { id: 902 })])
    ));
    const initial = await service.get(fullName);
    const saved = await service.updatePlan({
      expectedGraphRevision: initial.graphRevision,
      expectedRevision: 0,
      fullName,
      goals: [{ id: 'first-release', title: 'First release' }],
      items: [
        { goalId: 'first-release', issueNumber: 1, plannedState: 'active' },
        { goalId: 'first-release', issueNumber: 2, plannedState: 'planned' }
      ]
    });
    expect(saved.plan.items.map((entry) => entry.issue.id)).toEqual([901, 902]);
    const conflict = await service.updatePlan({
      expectedGraphRevision: saved.graphRevision,
      expectedRevision: 0,
      fullName,
      goals: [],
      items: []
    });
    expect(conflict.conflict).toBe('plan');
    expect(conflict.plan.revision).toBe(1);
  });

  test('rejects dependency order violations at the server boundary', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1), planItem(2)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter([issue(1), issue(2)], { 2: [issue(1)] })
    ));
    const current = await service.get(fullName);
    await expect(service.updatePlan({
      expectedGraphRevision: current.graphRevision,
      expectedRevision: current.plan.revision,
      fullName,
      goals: [],
      items: [
        { issueNumber: 2, plannedState: 'planned' },
        { issueNumber: 1, plannedState: 'planned' }
      ]
    })).rejects.toThrow('prerequisite before');
  });

  test('validates dependencies for issues newly added to the plan', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter([issue(1), issue(2)], { 2: [issue(1)] })
    ));
    const current = await service.get(fullName);
    await expect(service.updatePlan({
      expectedGraphRevision: current.graphRevision,
      expectedRevision: current.plan.revision,
      fullName,
      goals: [],
      items: [
        { issueNumber: 2, plannedState: 'planned' },
        { issueNumber: 1, plannedState: 'planned' }
      ]
    })).rejects.toThrow('prerequisite before');
  });

  test('loads dependency lists with bounded concurrency', async () => {
    const store = new InMemoryRoadmapPlanStore();
    const issues = Array.from({ length: 12 }, (_, index) => issue(index + 1));
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: issues.map((entry) => planItem(entry.number)),
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const baseRequest = repositoryRouter(issues);
    let active = 0;
    let maximumActive = 0;
    let dependencyCalls = 0;
    const request: RoadmapServiceDependencies['requestGitHub'] = async <T>(
      path: string,
      token: string,
      init?: RequestInit
    ) => {
      if (!path.includes('/dependencies/blocked_by?')) {
        return baseRequest<T>(path, token, init);
      }
      dependencyCalls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await baseRequest<T>(path, token, init);
      } finally {
        active -= 1;
      }
    };
    await new RoadmapService(dependencies(store, request)).get(fullName);
    expect(dependencyCalls).toBe(12);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(6);
  });

  test('reuses the fresh graph when a save keeps the same planned issue set', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1), planItem(2)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const calls: Array<{ init?: RequestInit; path: string }> = [];
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter([issue(1), issue(2)], {}, calls)
    ));
    const current = await service.get(fullName);
    calls.length = 0;
    await service.updatePlan({
      expectedGraphRevision: current.graphRevision,
      expectedRevision: current.plan.revision,
      fullName,
      goals: [],
      items: [
        { issueNumber: 2, plannedState: 'active' },
        { issueNumber: 1, plannedState: 'planned' }
      ]
    });
    expect(calls.filter((call) => call.path.includes('/dependencies/blocked_by?'))).toHaveLength(2);
  });

  test('requires personal OAuth and prevents a local dependency cycle', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1), planItem(2)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const router = repositoryRouter([issue(1), issue(2)], { 2: [issue(1)] });
    const noOAuth = new RoadmapService(dependencies(store, router, { oauth: false }));
    const read = await noOAuth.get(fullName);
    await expect(noOAuth.addDependency({
      blockedIssueNumber: 1,
      blocker: { fullName, issueNumber: 2 },
      expectedGraphRevision: read.graphRevision,
      fullName
    })).rejects.toThrow('GITHUB_AUTH_REQUIRED');

    const service = new RoadmapService(dependencies(store, router));
    await expect(service.addDependency({
      blockedIssueNumber: 1,
      blocker: { fullName, issueNumber: 2 },
      expectedGraphRevision: read.graphRevision,
      fullName
    })).rejects.toThrow('create a cycle');
  });

  test('prevents a cycle through dependencies outside the visible plan', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter(
        [issue(1), issue(2), issue(3)],
        { 2: [issue(1)], 3: [issue(2)] }
      )
    ));
    const current = await service.get(fullName);
    await expect(service.addDependency({
      blockedIssueNumber: 1,
      blocker: { fullName, issueNumber: 3 },
      expectedGraphRevision: current.graphRevision,
      fullName
    })).rejects.toThrow('create a cycle');
  });

  test('sends dependency writes as GitHub JSON requests', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(1), planItem(2)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const calls: Array<{ init?: RequestInit; path: string }> = [];
    const service = new RoadmapService(dependencies(
      store,
      repositoryRouter([issue(1), issue(2)], {}, calls)
    ));
    const current = await service.get(fullName);
    await service.addDependency({
      blockedIssueNumber: 2,
      blocker: { fullName, issueNumber: 1 },
      expectedGraphRevision: current.graphRevision,
      fullName
    });
    expect(calls.find((call) => call.init?.method === 'POST')?.init).toMatchObject({
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  test('keeps private dependency snapshots isolated per principal', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [planItem(2)],
      repositoryFullName: fullName,
      repositoryId: 42
    });
    const external = {
      ...issue(9, { id: 99 }),
      html_url: 'https://github.com/DotNaos/private/issues/9',
      repository_url: 'https://api.github.com/repos/DotNaos/private'
    };
    const alice = new RoadmapService(dependencies(
      store,
      repositoryRouter([issue(2)], { 2: [external] }),
      { principal: 'alice' }
    ));
    await alice.get(fullName);
    const bob = new RoadmapService(dependencies(
      store,
      repositoryRouter([issue(2)], { 2: new GitHubRequestError(404, false) }),
      { principal: 'bob' }
    ));
    const result = await bob.get(fullName);
    expect(result.dependencySync).toBe('stale');
    expect(result.dependencies).toEqual([]);
    expect(result.issues.some((entry) => entry.issue.fullName === 'DotNaos/private')).toBe(false);
  });
});
