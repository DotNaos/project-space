import { describe, expect, test } from 'bun:test';

import type {
  RoadmapDependency,
  RoadmapIssueNode,
  RoadmapPlanItem,
  RoadmapResult
} from '../src/shared/roadmap-api';
import { buildRoadmapGraph } from '../src/shared/roadmap-graph';

const repository = 'DotNaos/project-space';

function issue(
  number: number,
  options: {
    availability?: RoadmapIssueNode['availability'];
    fullName?: string;
    state?: RoadmapIssueNode['state'];
  } = {}
): RoadmapIssueNode {
  const fullName = options.fullName ?? repository;
  return {
    availability: options.availability ?? 'ready',
    issue: {
      fullName,
      id: number + (fullName === repository ? 0 : 10_000),
      number,
      url: `https://github.com/${fullName}/issues/${number}`
    },
    labels: [],
    state: options.state ?? 'open',
    title: `Issue ${number}`
  };
}

function dependency(
  blocker: RoadmapIssueNode,
  blocked: RoadmapIssueNode,
  freshness: RoadmapDependency['freshness'] = 'current'
): RoadmapDependency {
  return {
    blocked: blocked.issue,
    blocker: blocker.issue,
    freshness
  };
}

function result(
  issues: RoadmapIssueNode[],
  dependencies: RoadmapDependency[],
  items: RoadmapPlanItem[] = issues
    .filter((entry) => entry.issue.fullName === repository)
    .map((entry) => ({ issue: entry.issue, plannedState: 'planned' }))
): RoadmapResult {
  return {
    canEdit: true,
    checkedAt: '2026-07-27T00:00:00.000Z',
    dependencies,
    dependencySync: dependencies.some((edge) => edge.freshness === 'stale')
      ? 'stale'
      : 'current',
    graphRevision: '12345678',
    issues,
    plan: { goals: [], items, revision: 4 },
    repository: { fullName: repository, id: 42 },
    status: 'connected'
  };
}

describe('roadmap CLI graph', () => {
  test('emits every deterministic root-to-leaf path for forks and joins', () => {
    const root = issue(298, { state: 'closed' });
    const left = issue(412);
    const right = issue(413);
    const join = issue(420, { availability: 'blocked' });
    const standalone = issue(500);
    const independentRoot = issue(600);
    const independentLeaf = issue(601, { availability: 'blocked' });
    const graph = buildRoadmapGraph(result(
      [join, independentLeaf, standalone, right, independentRoot, root, left],
      [
        dependency(right, join),
        dependency(root, right),
        dependency(left, join),
        dependency(root, left),
        dependency(independentRoot, independentLeaf)
      ]
    ));

    expect(graph.nodes.map(({ number, state }) => [number, state])).toEqual([
      [298, 'DONE'],
      [412, 'READY'],
      [413, 'READY'],
      [420, 'WAIT'],
      [500, 'READY'],
      [600, 'READY'],
      [601, 'WAIT']
    ]);
    expect(graph.edges.map(({ from, satisfied, to }) => [
      from.number,
      to.number,
      satisfied
    ])).toEqual([
      [298, 412, true],
      [298, 413, true],
      [412, 420, false],
      [413, 420, false],
      [600, 601, false]
    ]);
    expect(graph.paths.map((path) => path.map((node) => node.number))).toEqual([
      [298, 412, 420],
      [298, 413, 420],
      [500],
      [600, 601]
    ]);
  });

  test('keeps active state explicit and preserves cross-repository blockers', () => {
    const external = issue(7, {
      fullName: 'DotNaos/platform',
      state: 'closed'
    });
    const active = issue(10, { availability: 'blocked' });
    const graph = buildRoadmapGraph(result(
      [active, external],
      [dependency(external, active)],
      [{ issue: active.issue, plannedState: 'active' }]
    ));

    expect(graph).toMatchObject({
      dependencyFreshness: 'current',
      graphRevision: '12345678',
      paths: [[
        { number: 7, repository: 'DotNaos/platform' },
        { number: 10, repository }
      ]],
      repository
    });
    expect(graph.nodes.map(({ number, repository: fullName, state }) => [
      fullName,
      number,
      state
    ])).toEqual([
      ['DotNaos/platform', 7, 'DONE'],
      [repository, 10, 'ACTIVE']
    ]);
  });

  test('rejects cyclic dependency snapshots instead of hiding paths', () => {
    const first = issue(1, { availability: 'cyclic' });
    const second = issue(2, { availability: 'cyclic' });
    expect(() => buildRoadmapGraph(result(
      [first, second],
      [dependency(first, second), dependency(second, first)]
    ))).toThrow('contains a cycle');
  });
});
