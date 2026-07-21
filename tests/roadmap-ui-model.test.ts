import { describe, expect, test } from 'bun:test';

import {
  filterRoadmapIssues,
  roadmapIssueLoadForRepository
} from '../src/features/roadmap/roadmap-issue-picker-model';
import {
  roadmapPlannedSuccessorCandidates,
  roadmapRelationshipRequest
} from '../src/features/roadmap/roadmap-relationship-model';
import {
  roadmapSelectedIssueId,
  roadmapSelectionUrl
} from '../src/features/roadmap/use-roadmap-selection';

const issues = [
  { id: 1, labels: ['graph'], number: 273, state: 'open' as const, title: 'Actionable roadmap graph', url: 'https://example.test/273' },
  { id: 2, labels: ['mobile'], number: 211, state: 'closed' as const, title: 'Durable roadmap model', url: 'https://example.test/211' },
  { id: 3, labels: [], number: 301, state: 'open' as const, title: 'Connector recovery', url: 'https://example.test/301' }
];

describe('roadmap UI models', () => {
  test('filters searchable issue candidates and excludes already planned work', () => {
    expect(filterRoadmapIssues(issues, 'graph', new Set()).map((issue) => issue.number))
      .toEqual([273]);
    expect(filterRoadmapIssues(issues, '#301', new Set()).map((issue) => issue.number))
      .toEqual([301]);
    expect(filterRoadmapIssues(issues, 'mobile', new Set([211]))).toEqual([]);
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
