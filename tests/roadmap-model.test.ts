import { describe, expect, test } from 'bun:test';

import {
  buildRoadmapStory,
  nextRoadmapPlanEntry
} from '../src/features/roadmap/roadmap-model';
import type {
  RoadmapDependency,
  RoadmapIssueNode,
  RoadmapIssueReference,
  RoadmapPlanItem
} from '../src/shared/roadmap-api';
import {
  moveRoadmapItem,
  roadmapAdditionIndex,
  roadmapCyclicIssueKeys,
  roadmapDependencyCycle,
  roadmapGraphRevision,
  roadmapIssueKey,
  roadmapOrderViolations,
  validRoadmapMoveRange
} from '../src/shared/roadmap-model';

const ref = (number: number, id = number, fullName = 'DotNaos/project-space') => ({
  fullName,
  id,
  number
}) satisfies RoadmapIssueReference;
const item = (number: number, id = number): RoadmapPlanItem => ({
  issue: ref(number, id),
  plannedState: 'planned'
});
const edge = (blocker: RoadmapIssueReference, blocked: RoadmapIssueReference): RoadmapDependency => ({
  blocked,
  blocker,
  freshness: 'current'
});
const node = (issue: RoadmapIssueReference): RoadmapIssueNode => ({
  availability: 'ready',
  issue,
  labels: [],
  state: 'open',
  title: `Issue ${issue.number}`
});

describe('roadmap model', () => {
  test('uses stable global GitHub issue IDs across repository renames', () => {
    expect(roadmapIssueKey(ref(12, 901, 'old/name'))).toBe(
      roadmapIssueKey(ref(12, 901, 'new/name'))
    );
    expect(roadmapIssueKey(ref(12, 902, 'new/name'))).not.toBe(
      roadmapIssueKey(ref(12, 901, 'new/name'))
    );
  });

  test('makes graph revisions edge-order independent', () => {
    const first = edge(ref(1), ref(2));
    const second = edge(ref(2), ref(3));
    expect(roadmapGraphRevision([first, second])).toBe(roadmapGraphRevision([second, first]));
    expect(roadmapGraphRevision([first])).not.toBe(roadmapGraphRevision([first, second]));
  });

  test('detects direct and multi-hop cycles while accepting a diamond', () => {
    const one = ref(1);
    const two = ref(2);
    const three = ref(3);
    const four = ref(4);
    const diamond = [edge(one, two), edge(one, three), edge(two, four), edge(three, four)];
    expect(roadmapDependencyCycle(diamond)).toBe(false);
    expect(roadmapDependencyCycle(diamond, { blocked: one, blocker: four })).toBe(true);
    expect(roadmapDependencyCycle([], { blocked: one, blocker: one })).toBe(true);
    expect(roadmapCyclicIssueKeys([...diamond, edge(four, one)])).toEqual(
      new Set(['1', '2', '3', '4'])
    );
  });

  test('keeps manual order independent except where dependencies constrain it', () => {
    const items = [item(1), item(2), item(3), item(4)];
    const dependencies = [edge(ref(1), ref(3))];
    expect(roadmapOrderViolations(items, dependencies)).toEqual([]);
    expect(roadmapOrderViolations([item(3), item(2), item(1)], dependencies)).toHaveLength(1);
    expect(validRoadmapMoveRange(items, dependencies, ref(1))).toEqual({ minimum: 0, maximum: 1 });
    expect(validRoadmapMoveRange(items, dependencies, ref(3))).toEqual({ minimum: 1, maximum: 3 });
    expect(moveRoadmapItem(items, ref(2), 3, dependencies)?.map((entry) => entry.issue.number))
      .toEqual([1, 3, 4, 2]);
    expect(moveRoadmapItem(items, ref(1), 3, dependencies)).toBeUndefined();
  });

  test('inserts newly planned context at a dependency-safe position', () => {
    const contextualPrerequisite = ref(9);
    const items = [item(2), item(3), item(4)];
    expect(roadmapAdditionIndex(items, [edge(contextualPrerequisite, ref(2))], contextualPrerequisite))
      .toBe(0);
    expect(roadmapAdditionIndex(items, [edge(ref(3), contextualPrerequisite)], contextualPrerequisite))
      .toBe(3);
    expect(roadmapAdditionIndex(items, [], contextualPrerequisite)).toBe(items.length);
  });

  test('builds a vertical story that includes external prerequisites', () => {
    const external = ref(9, 99, 'DotNaos/other');
    const items = [item(1), item(2), item(3)];
    const dependencies = [edge(external, ref(2)), edge(ref(2), ref(3))];
    const story = buildRoadmapStory(
      { goals: [], items, revision: 1 },
      [...items.map((entry) => node(entry.issue)), node(external)],
      dependencies
    );
    expect(story.nodes.map((entry) => [entry.issue.issue.number, entry.depth])).toEqual([
      [1, 0],
      [9, 0],
      [2, 1],
      [3, 2]
    ]);
    expect(story.nodes.find((entry) => entry.issue.issue.id === 99)?.planItem).toBeUndefined();
    expect(story.edges).toHaveLength(2);
  });

  test('recommends ready work instead of an active blocked issue', () => {
    const first = { ...node(ref(1)), availability: 'blocked' as const };
    const second = node(ref(2));
    const plan = {
      goals: [],
      items: [
        { issue: first.issue, plannedState: 'active' as const },
        { issue: second.issue, plannedState: 'planned' as const }
      ],
      revision: 1
    };
    expect(nextRoadmapPlanEntry(plan, [first, second])?.issue?.issue.number).toBe(2);
  });
});
