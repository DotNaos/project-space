import { describe, expect, test } from 'bun:test';

import {
  filterRoadmapIssues,
  roadmapIssueLoadForRepository
} from '../src/features/roadmap/roadmap-issue-picker-model';
import {
  roadmapGraphVisibility
} from '../src/features/roadmap/roadmap-model';
import {
  roadmapPlannedSuccessorCandidates,
  roadmapRelationshipRequest
} from '../src/features/roadmap/roadmap-relationship-model';
import {
  roadmapSelectedIssueId,
  roadmapSelectionUrl
} from '../src/features/roadmap/use-roadmap-selection';
import {
  pointIsInsideElement,
  roadmapMovePositionLabel,
  roadmapSpatialMoveIndex,
  roadmapWorkShelfAdditionIndex,
  roadmapWorkShelfInsertionIndex,
  roadmapWorkShelfIssues,
  roadmapWorkShelfPlanLabel
} from '../src/features/roadmap/roadmap-work-shelf-model';
import { optimisticRoadmapPlan } from '../src/features/roadmap/roadmap-optimistic';

const issues = [
  { id: 1, labels: ['graph'], number: 273, state: 'open' as const, title: 'Actionable roadmap graph', url: 'https://example.test/273' },
  { id: 2, labels: ['mobile'], number: 211, state: 'closed' as const, title: 'Durable roadmap model', url: 'https://example.test/211' },
  { id: 3, labels: [], number: 301, state: 'open' as const, title: 'Connector recovery', url: 'https://example.test/301' }
];

describe('roadmap UI models', () => {
  test('hides completed graph nodes without changing plan positions or inventing edges', () => {
    const closedBlocker = {
      availability: 'closed' as const,
      issue: { fullName: 'DotNaos/project-space', id: 185, number: 185 },
      labels: [],
      state: 'closed' as const,
      title: 'Group connector installations'
    };
    const closedPlanned = {
      availability: 'closed' as const,
      issue: { fullName: 'DotNaos/project-space', id: 211, number: 211 },
      labels: [],
      state: 'closed' as const,
      title: 'Roadmap of Goals'
    };
    const openPlanned = {
      availability: 'ready' as const,
      issue: { fullName: 'DotNaos/project-space', id: 263, number: 263 },
      labels: [],
      state: 'open' as const,
      title: 'PR Preview Deployment'
    };
    const dependencies = [
      { blocked: closedPlanned.issue, blocker: closedBlocker.issue, freshness: 'current' as const },
      { blocked: openPlanned.issue, blocker: closedPlanned.issue, freshness: 'current' as const }
    ];
    const result = {
      canEdit: true,
      checkedAt: '2026-07-21T00:00:00.000Z',
      dependencies,
      dependencySync: 'current' as const,
      graphRevision: 'graph',
      issues: [closedBlocker, closedPlanned, openPlanned],
      plan: {
        goals: [],
        items: [closedPlanned, openPlanned].map((node) => ({
          issue: node.issue,
          plannedState: 'planned' as const
        })),
        revision: 2
      },
      repository: { fullName: 'DotNaos/project-space', id: 42 },
      status: 'connected' as const
    };

    expect(roadmapGraphVisibility(result, false)).toMatchObject({
      completedCount: 2,
      dependencies: [],
      issues: [openPlanned]
    });
    expect(roadmapGraphVisibility(result, true)).toMatchObject({
      completedCount: 2,
      dependencies,
      issues: [closedBlocker, closedPlanned, openPlanned]
    });
    expect(result.plan.items.map((item) => item.issue.number)).toEqual([211, 263]);
  });

  test('drops open context nodes when every durable plan item is completed', () => {
    const completedPlanItem = {
      availability: 'closed' as const,
      issue: { fullName: 'DotNaos/project-space', id: 211, number: 211 },
      labels: [],
      state: 'closed' as const,
      title: 'Roadmap of Goals'
    };
    const openContextBlocker = {
      availability: 'blocked' as const,
      issue: { fullName: 'DotNaos/project-space', id: 185, number: 185 },
      labels: [],
      state: 'open' as const,
      title: 'External prerequisite'
    };
    const result = {
      canEdit: true,
      checkedAt: '2026-07-21T00:00:00.000Z',
      dependencies: [{
        blocked: completedPlanItem.issue,
        blocker: openContextBlocker.issue,
        freshness: 'current' as const
      }],
      dependencySync: 'current' as const,
      graphRevision: 'graph',
      issues: [openContextBlocker, completedPlanItem],
      plan: {
        goals: [],
        items: [{ issue: completedPlanItem.issue, plannedState: 'planned' as const }],
        revision: 1
      },
      repository: { fullName: 'DotNaos/project-space', id: 42 },
      status: 'connected' as const
    };

    expect(roadmapGraphVisibility(result, false)).toMatchObject({
      completedCount: 1,
      dependencies: [],
      issues: []
    });
    expect(roadmapGraphVisibility(result, true).issues).toEqual([
      openContextBlocker,
      completedPlanItem
    ]);
  });

  test('filters searchable issue candidates and excludes already planned work', () => {
    expect(filterRoadmapIssues(issues, 'graph', new Set()).map((issue) => issue.number))
      .toEqual([273]);
    expect(filterRoadmapIssues(issues, '#301', new Set()).map((issue) => issue.number))
      .toEqual([301]);
    expect(filterRoadmapIssues(issues, 'mobile', new Set([211]))).toEqual([]);
  });

  test('lists every unplanned shelf issue with open work before completed work', () => {
    const result = {
      plan: {
        goals: [],
        items: [{
          issue: { fullName: 'DotNaos/project-space', id: 273, number: 273 },
          plannedState: 'planned' as const
        }],
        revision: 1
      }
    };

    expect(roadmapWorkShelfIssues(issues, result, '').map((issue) => issue.number))
      .toEqual([301, 211]);
    expect(roadmapWorkShelfIssues(issues, result, 'mobile').map((issue) => issue.number))
      .toEqual([211]);
    expect(roadmapWorkShelfIssues(issues, result, '#301').map((issue) => issue.number))
      .toEqual([301]);
  });

  test('shows the exact durable plan position without changing dependency truth', () => {
    const prerequisite = {
      availability: 'ready' as const,
      issue: { fullName: 'DotNaos/project-space', id: 301, number: 301 },
      labels: [],
      state: 'open' as const,
      title: 'Connector recovery'
    };
    const planned = {
      availability: 'blocked' as const,
      issue: { fullName: 'DotNaos/project-space', id: 273, number: 273 },
      labels: [],
      state: 'open' as const,
      title: 'Actionable roadmap graph'
    };
    const dependency = {
      blocked: planned.issue,
      blocker: prerequisite.issue,
      freshness: 'current' as const
    };
    const result = {
      canEdit: true,
      checkedAt: '2026-07-22T00:00:00.000Z',
      dependencies: [dependency],
      dependencySync: 'current' as const,
      graphRevision: 'graph',
      issues: [prerequisite, planned],
      plan: {
        goals: [],
        items: [{ issue: planned.issue, plannedState: 'planned' as const }],
        revision: 1
      },
      repository: { fullName: 'DotNaos/project-space', id: 42 },
      status: 'connected' as const
    };

    expect(roadmapWorkShelfAdditionIndex(result, issues[2])).toBe(0);
    expect(roadmapWorkShelfPlanLabel(0)).toBe('Plan 01');
    expect(roadmapWorkShelfAdditionIndex(result, { number: 999 })).toBe(1);
    expect(result.dependencies).toEqual([dependency]);
    expect(roadmapWorkShelfInsertionIndex(result, issues[2], 0)).toBe(0);
    expect(roadmapWorkShelfInsertionIndex(result, issues[2], 1)).toBe(0);
    expect(roadmapWorkShelfInsertionIndex(result, { number: 999 }, 1)).toBe(1);
  });

  test('maps planned-node dragging to dependency-safe beginning, middle, and end positions', () => {
    const nodes = [10, 20, 30].map((number) => ({
      issue: { fullName: 'DotNaos/project-space', id: number, number },
      plannedState: 'planned' as const
    }));
    const result = {
      canEdit: true,
      checkedAt: '2026-07-22T00:00:00.000Z',
      dependencies: [{
        blocked: nodes[2]!.issue,
        blocker: nodes[0]!.issue,
        freshness: 'current' as const
      }],
      dependencySync: 'current' as const,
      graphRevision: 'graph',
      issues: [],
      plan: { goals: [], items: nodes, revision: 1 },
      repository: { fullName: 'DotNaos/project-space', id: 42 },
      status: 'connected' as const
    };

    expect(roadmapSpatialMoveIndex(result, nodes[1]!.issue, 0)).toBe(0);
    expect(roadmapSpatialMoveIndex(result, nodes[1]!.issue, 0.5)).toBe(1);
    expect(roadmapSpatialMoveIndex(result, nodes[1]!.issue, 1)).toBe(2);
    expect(roadmapMovePositionLabel(result, nodes[1]!.issue, 0)).toBe('Beginning');
    expect(roadmapMovePositionLabel(result, nodes[1]!.issue, 2)).toBe('End');
    expect(roadmapSpatialMoveIndex(result, nodes[2]!.issue, 0)).toBe(1);
  });

  test('publishes a complete optimistic issue node before the server responds', () => {
    const base = {
      canEdit: true,
      checkedAt: '2026-07-22T00:00:00.000Z',
      dependencies: [],
      dependencySync: 'current' as const,
      graphRevision: 'graph-1',
      issues: [],
      plan: { goals: [], items: [], revision: 7 },
      repository: { fullName: 'DotNaos/project-space', id: 42 },
      status: 'connected' as const
    };
    const optimistic = optimisticRoadmapPlan(
      base,
      [],
      [{ issueNumber: 263, plannedState: 'planned' }],
      { ...issues[2], body: 'Visible immediately', id: 263, number: 263 }
    );

    expect(optimistic.plan.revision).toBe(7);
    expect(optimistic.graphRevision).toBe('graph-1');
    expect(optimistic.plan.items[0]?.issue.number).toBe(263);
    expect(optimistic.issues[0]).toMatchObject({
      issue: { id: 263, number: 263 },
      title: 'Connector recovery'
    });
    expect(base.plan.items).toEqual([]);
  });

  test('only accepts drops inside the visible roadmap canvas', () => {
    const rect = { bottom: 500, left: 20, right: 720, top: 100 };
    expect(pointIsInsideElement({ x: 400, y: 300 }, rect)).toBeTrue();
    expect(pointIsInsideElement({ x: 400, y: 501 }, rect)).toBeFalse();
  });

  test('round trips selected issue identity through a direct URL without losing other query state', () => {
    const location = {
      hash: '#details',
      pathname: '/projects/project/roadmap',
      search: '?machine=os-macbook'
    } as Location;
    const selected = roadmapSelectionUrl(location, 987654);
    expect(selected).toBe('/projects/project/roadmap?machine=os-macbook&roadmapIssue=987654#details');
    expect(roadmapSelectedIssueId('?machine=os-macbook&roadmapIssue=987654')).toBe(987654);
    expect(roadmapSelectionUrl({ ...location, search: '?roadmapIssue=987654' } as Location))
      .toBe('/projects/project/roadmap#details');
  });

  test('rejects malformed selected issue parameters', () => {
    expect(roadmapSelectedIssueId('?roadmapIssue=-1')).toBeUndefined();
    expect(roadmapSelectedIssueId('?roadmapIssue=abc')).toBeUndefined();
    expect(roadmapSelectedIssueId('?roadmapIssue=0')).toBeUndefined();
  });

  test('never exposes issue candidates loaded for a previous repository', () => {
    const loaded = {
      error: '',
      fullName: 'DotNaos/first',
      issues
    };
    expect(roadmapIssueLoadForRepository(loaded, 'DotNaos/first')?.issues).toEqual(issues);
    expect(roadmapIssueLoadForRepository(loaded, 'DotNaos/second')).toBeUndefined();
  });

  test('clears the current selection URL instead of reopening an earlier selection', () => {
    const current = {
      hash: '',
      pathname: '/projects/project/roadmap',
      search: '?roadmapIssue=222'
    } as Location;
    expect(roadmapSelectionUrl(current)).toBe('/projects/project/roadmap');
    expect(roadmapSelectionUrl(current, 111)).toBe('/projects/project/roadmap?roadmapIssue=111');
  });

  test('builds directional dependency requests and only offers planned successors', () => {
    const selected = {
      availability: 'ready' as const,
      issue: { fullName: 'DotNaos/project-space', id: 1, number: 10 },
      labels: [],
      state: 'open' as const,
      title: 'Selected issue'
    };
    expect(roadmapRelationshipRequest('prerequisite', selected, 9, 'DotNaos/other')).toEqual({
      blockedIssueNumber: 10,
      blocker: { fullName: 'DotNaos/other', issueNumber: 9 }
    });
    expect(roadmapRelationshipRequest('successor', selected, 11, '')).toEqual({
      blockedIssueNumber: 11,
      blocker: { fullName: 'DotNaos/project-space', issueNumber: 10 }
    });
    const successor = {
      ...selected,
      issue: { ...selected.issue, id: 2, number: 11 },
      title: 'Planned successor'
    };
    const unplanned = {
      ...selected,
      issue: { ...selected.issue, id: 3, number: 12 },
      title: 'Unplanned issue'
    };
    const result = {
      canEdit: true,
      checkedAt: '2026-07-20T00:00:00.000Z',
      dependencies: [],
      dependencySync: 'current' as const,
      graphRevision: 'graph',
      issues: [selected, successor, unplanned],
      plan: {
        goals: [],
        items: [selected, successor].map((node) => ({ issue: node.issue, plannedState: 'planned' as const })),
        revision: 1
      },
      repository: { fullName: 'DotNaos/project-space', id: 42 },
      status: 'connected' as const
    };
    expect(roadmapPlannedSuccessorCandidates(result).map((issue) => issue.number))
      .toEqual([10, 11]);
  });
});
