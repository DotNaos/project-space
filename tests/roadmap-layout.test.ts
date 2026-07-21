import { describe, expect, test } from 'bun:test';

import { layoutRoadmapGraph } from '../src/features/roadmap/roadmap-layout';
import {
  roadmapReactFlowEdges,
  roadmapReactFlowNodes
} from '../src/features/roadmap/roadmap-react-flow-model';
import type {
  RoadmapDependency,
  RoadmapIssueNode,
  RoadmapIssueReference,
  RoadmapPlan
} from '../src/shared/roadmap-api';

const ref = (number: number): RoadmapIssueReference => ({
  fullName: 'DotNaos/project-space',
  id: number,
  number
});
const issue = (number: number, title = `Issue ${number}`): RoadmapIssueNode => ({
  availability: 'ready',
  issue: ref(number),
  labels: [],
  state: 'open',
  title
});
const edge = (blocker: number, blocked: number): RoadmapDependency => ({
  blocked: ref(blocked),
  blocker: ref(blocker),
  freshness: 'current'
});
const plan = (numbers: number[], goals: RoadmapPlan['goals'] = []): RoadmapPlan => ({
  goals,
  items: numbers.map((number) => ({
    goalId: goals[0]?.id,
    issue: ref(number),
    plannedState: 'planned'
  })),
  revision: 1
});

describe('roadmap graph layout', () => {
  test('lays out a linear chain from top to bottom', () => {
    const layout = layoutRoadmapGraph(
      plan([1, 2, 3]),
      [issue(1), issue(2), issue(3)],
      [edge(1, 2), edge(2, 3)]
    );
    expect(layout.nodes.map((node) => [node.issue.issue.number, node.rank])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2]
    ]);
    expect(layout.nodes[0]?.isRoot).toBe(true);
    expect(layout.nodes[2]?.isTerminal).toBe(true);
  });

  test('shows forks, joins, multiple roots, and multiple valid terminal leaves', () => {
    const dependencies = [
      edge(1, 3),
      edge(1, 4),
      edge(2, 4),
      edge(3, 5)
    ];
    const layout = layoutRoadmapGraph(
      plan([1, 2, 3, 4, 5]),
      [1, 2, 3, 4, 5].map((number) => issue(number)),
      dependencies
    );
    const byNumber = new Map(layout.nodes.map((node) => [node.issue.issue.number, node]));
    expect([byNumber.get(1)?.rank, byNumber.get(2)?.rank]).toEqual([0, 0]);
    expect([byNumber.get(3)?.rank, byNumber.get(4)?.rank]).toEqual([1, 1]);
    expect(byNumber.get(3)?.position.x).not.toBe(byNumber.get(4)?.position.x);
    expect(byNumber.get(4)?.incoming).toHaveLength(2);
    expect([byNumber.get(4)?.isTerminal, byNumber.get(5)?.isTerminal]).toEqual([true, true]);
  });

  test('uses manual order only as a stable badge and tie breaker, never as an edge', () => {
    const layout = layoutRoadmapGraph(
      plan([3, 1, 2]),
      [issue(1), issue(2), issue(3)],
      []
    );
    expect(layout.edges).toEqual([]);
    expect(layout.nodes.map((node) => [node.issue.issue.number, node.planPosition])).toEqual([
      [3, 1],
      [1, 2],
      [2, 3]
    ]);
    expect(roadmapReactFlowEdges(layout)).toEqual([]);
  });

  test('derives goal boundaries and expands long-title nodes without persisting positions', () => {
    const goal = { id: 'reliable', title: 'Reliable connector management' };
    const layout = layoutRoadmapGraph(
      plan([1, 2], [goal]),
      [
        issue(1),
        issue(2, 'A deliberately long issue title that wraps across several lines without clipping')
      ],
      [edge(1, 2)],
      true
    );
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]?.goal).toEqual(goal);
    expect(layout.nodes[1]?.dimensions.height).toBeGreaterThan(layout.nodes[0]?.dimensions.height ?? 0);
    expect(roadmapReactFlowNodes(layout)[0]?.selectable).toBe(false);
    expect(roadmapReactFlowNodes(layout).filter((node) => node.data.kind === 'issue'))
      .toHaveLength(2);
  });

  test('keeps multiple goal boundaries in separate non-overlapping lanes', () => {
    const goals = [
      { id: 'a', title: 'Goal A' },
      { id: 'b', title: 'Goal B' }
    ];
    const roadmapPlan: RoadmapPlan = {
      goals,
      items: [1, 2, 3, 4].map((number, index) => ({
        goalId: index % 2 === 0 ? 'a' : 'b',
        issue: ref(number),
        plannedState: 'planned'
      })),
      revision: 1
    };
    const layout = layoutRoadmapGraph(
      roadmapPlan,
      [1, 2, 3, 4].map((number) => issue(number)),
      []
    );
    const [groupA, groupB] = layout.groups;
    expect(groupA && groupB && rectanglesOverlap(groupA, groupB)).toBe(false);
    for (const node of layout.nodes) {
      const ownGroup = layout.groups.find((group) => group.goal.id === node.goalId);
      const otherGroup = layout.groups.find((group) => group.goal.id !== node.goalId);
      expect(ownGroup && containsCenter(ownGroup, node)).toBe(true);
      expect(otherGroup && containsCenter(otherGroup, node)).toBe(false);
    }
  });

  test('keeps dependency edges keyboard focusable with honest direction labels', () => {
    const layout = layoutRoadmapGraph(
      plan([1, 2]),
      [issue(1), issue(2)],
      [edge(1, 2)]
    );
    const activated: number[] = [];
    const flowEdge = roadmapReactFlowEdges(layout, (blockedIssueId) => {
      activated.push(blockedIssueId);
    })[0];
    expect(flowEdge).toMatchObject({
      ariaLabel: 'Dependency: #1 unlocks #2',
      ariaRole: 'button',
      focusable: true,
      source: 'roadmap:issue:1',
      target: 'roadmap:issue:2'
    });
    flowEdge?.domAttributes?.onKeyDown?.({
      key: 'Enter',
      preventDefault() {}
    } as never);
    expect(activated).toEqual([2]);
  });
});

function rectanglesOverlap(
  left: Pick<NonNullable<ReturnType<typeof layoutRoadmapGraph>['groups'][number]>, 'dimensions' | 'position'>,
  right: Pick<NonNullable<ReturnType<typeof layoutRoadmapGraph>['groups'][number]>, 'dimensions' | 'position'>
) {
  return left.position.x < right.position.x + right.dimensions.width
    && left.position.x + left.dimensions.width > right.position.x
    && left.position.y < right.position.y + right.dimensions.height
    && left.position.y + left.dimensions.height > right.position.y;
}

function containsCenter(
  group: ReturnType<typeof layoutRoadmapGraph>['groups'][number],
  node: ReturnType<typeof layoutRoadmapGraph>['nodes'][number]
) {
  const x = node.position.x + node.dimensions.width / 2;
  const y = node.position.y + node.dimensions.height / 2;
  return x >= group.position.x
    && x <= group.position.x + group.dimensions.width
    && y >= group.position.y
    && y <= group.position.y + group.dimensions.height;
}
