import type {
  RoadmapDependency,
  RoadmapGoal,
  RoadmapIssueNode,
  RoadmapPlan,
  RoadmapPlanItem
} from '../../shared/roadmap-api';
import { roadmapIssueKey } from '../../shared/roadmap-model';

export interface RoadmapLayoutPoint {
  x: number;
  y: number;
}

export interface RoadmapLayoutSize {
  height: number;
  width: number;
}

export interface RoadmapLayoutNode {
  dimensions: RoadmapLayoutSize;
  goalId?: string;
  id: string;
  incoming: RoadmapDependency[];
  issue: RoadmapIssueNode;
  isRoot: boolean;
  isTerminal: boolean;
  outgoing: RoadmapDependency[];
  planItem?: RoadmapPlanItem;
  planPosition?: number;
  position: RoadmapLayoutPoint;
  rank: number;
}

export interface RoadmapLayoutGroup {
  dimensions: RoadmapLayoutSize;
  goal: RoadmapGoal;
  id: string;
  position: RoadmapLayoutPoint;
}

export interface RoadmapLayout {
  bounds: RoadmapLayoutPoint & RoadmapLayoutSize;
  edges: RoadmapDependency[];
  groups: RoadmapLayoutGroup[];
  nodes: RoadmapLayoutNode[];
}

const dimensions = {
  compactNodeWidth: 208,
  desktopNodeWidth: 236,
  groupHorizontalPadding: 22,
  groupLabelHeight: 40,
  groupVerticalPadding: 18,
  horizontalGapCompact: 24,
  horizontalGapDesktop: 54,
  verticalGap: 74
} as const;

export function layoutRoadmapGraph(
  plan: RoadmapPlan,
  issues: readonly RoadmapIssueNode[],
  dependencies: readonly RoadmapDependency[],
  compact = false
): RoadmapLayout {
  const issuesByKey = new Map(issues.map((issue) => [roadmapIssueKey(issue.issue), issue]));
  const visibleEdges = dependencies.filter((edge) => (
    issuesByKey.has(roadmapIssueKey(edge.blocker))
    && issuesByKey.has(roadmapIssueKey(edge.blocked))
  ));
  const incoming = relationshipMap(visibleEdges, 'blocked');
  const outgoing = relationshipMap(visibleEdges, 'blocker');
  const planItems = new Map(plan.items.map((item, index) => [
    roadmapIssueKey(item.issue),
    { item, position: index }
  ]));
  const order = (key: string) => planItems.get(key)?.position
    ?? plan.items.length + (issuesByKey.get(key)?.issue.number ?? Number.MAX_SAFE_INTEGER);
  const laneFor = (key: string) => planItems.get(key)?.item.goalId
    ? `goal:${planItems.get(key)?.item.goalId}`
    : 'ungrouped';
  const usedLanes = new Set([...issuesByKey.keys()].map(laneFor));
  const laneIds = [
    ...plan.goals.map((goal) => `goal:${goal.id}`).filter((id) => usedLanes.has(id)),
    ...[...usedLanes].filter((id) => id === 'ungrouped' || !plan.goals.some((goal) => id === `goal:${goal.id}`))
  ];
  const lanePositions = new Map(laneIds.map((id, index) => [id, index]));
  const ranks = graphRanks([...issuesByKey.keys()], visibleEdges, order);
  const layers = orderedLayers(
    [...issuesByKey.keys()],
    ranks,
    incoming,
    order,
    (key) => lanePositions.get(laneFor(key)) ?? Number.MAX_SAFE_INTEGER
  );
  const nodeWidth = compact ? dimensions.compactNodeWidth : dimensions.desktopNodeWidth;
  const horizontalGap = compact
    ? dimensions.horizontalGapCompact
    : dimensions.horizontalGapDesktop;
  const laneWidths = new Map(laneIds.map((laneId) => {
    const maximumMembers = Math.max(1, ...layers.map((layer) => (
      layer.filter((key) => laneFor(key) === laneId).length
    )));
    return [
      laneId,
      maximumMembers * nodeWidth + Math.max(0, maximumMembers - 1) * horizontalGap
    ];
  }));
  const laneGap = horizontalGap + dimensions.groupHorizontalPadding * 2;
  const nodes: RoadmapLayoutNode[] = [];
  let y = dimensions.groupLabelHeight;

  layers.forEach((layer, rank) => {
    const heights = layer.map((key) => nodeHeight(issuesByKey.get(key)?.title ?? ''));
    const layerHeight = Math.max(...heights, 0);
    let laneX = 0;
    laneIds.forEach((laneId) => {
      const members = layer.filter((key) => laneFor(key) === laneId);
      const laneWidth = laneWidths.get(laneId) ?? nodeWidth;
      const membersWidth = members.length * nodeWidth
        + Math.max(0, members.length - 1) * horizontalGap;
      let x = laneX + (laneWidth - membersWidth) / 2;
      members.forEach((key) => {
        const issue = issuesByKey.get(key);
        if (!issue) return;
        const planned = planItems.get(key);
        const incomingEdges = incoming.get(key) ?? [];
        const outgoingEdges = outgoing.get(key) ?? [];
        nodes.push({
          dimensions: { height: nodeHeight(issue.title), width: nodeWidth },
          goalId: planned?.item.goalId,
          id: roadmapNodeId(issue.issue.id),
          incoming: incomingEdges,
          issue,
          isRoot: incomingEdges.length === 0,
          isTerminal: outgoingEdges.length === 0,
          outgoing: outgoingEdges,
          planItem: planned?.item,
          planPosition: planned ? planned.position + 1 : undefined,
          position: { x, y },
          rank
        });
        x += nodeWidth + horizontalGap;
      });
      laneX += laneWidth + laneGap;
    });
    y += layerHeight + dimensions.verticalGap;
  });

  const groups = goalGroups(plan.goals, nodes);
  const extents = graphExtents(nodes, groups);
  return {
    bounds: extents,
    edges: visibleEdges,
    groups,
    nodes: translateLayout(nodes, groups, extents),
  };
}

export function roadmapNodeId(issueId: number) {
  return `roadmap:issue:${issueId}`;
}

function relationshipMap(
  edges: readonly RoadmapDependency[],
  side: 'blocked' | 'blocker'
) {
  const result = new Map<string, RoadmapDependency[]>();
  for (const edge of edges) {
    const key = roadmapIssueKey(edge[side]);
    result.set(key, [...(result.get(key) ?? []), edge]);
  }
  return result;
}

function graphRanks(
  keys: string[],
  edges: readonly RoadmapDependency[],
  order: (key: string) => number
) {
  const indegree = new Map(keys.map((key) => [key, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const source = roadmapIssueKey(edge.blocker);
    const target = roadmapIssueKey(edge.blocked);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
    outgoing.set(source, [...(outgoing.get(source) ?? []), target]);
  }
  const ranks = new Map(keys.map((key) => [key, 0]));
  const queue = keys.filter((key) => indegree.get(key) === 0).sort((a, b) => order(a) - order(b));
  while (queue.length > 0) {
    const key = queue.shift();
    if (!key) break;
    for (const target of outgoing.get(key) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(key) ?? 0) + 1));
      const next = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, next);
      if (next === 0) {
        queue.push(target);
        queue.sort((a, b) => order(a) - order(b));
      }
    }
  }
  return ranks;
}

function orderedLayers(
  keys: string[],
  ranks: ReadonlyMap<string, number>,
  incoming: ReadonlyMap<string, RoadmapDependency[]>,
  order: (key: string) => number,
  lane: (key: string) => number
) {
  const maximumRank = Math.max(0, ...ranks.values());
  const layers = Array.from({ length: maximumRank + 1 }, () => [] as string[]);
  keys.forEach((key) => layers[ranks.get(key) ?? 0]?.push(key));
  const positions = new Map<string, number>();
  layers.forEach((layer, rank) => {
    layer.sort((left, right) => {
      const leftCenter = parentCenter(left, incoming, positions);
      const rightCenter = parentCenter(right, incoming, positions);
      return lane(left) - lane(right) || leftCenter - rightCenter || order(left) - order(right);
    });
    layer.forEach((key, index) => positions.set(key, index + rank * 1_000));
  });
  return layers;
}

function parentCenter(
  key: string,
  incoming: ReadonlyMap<string, RoadmapDependency[]>,
  positions: ReadonlyMap<string, number>
) {
  const values = (incoming.get(key) ?? []).flatMap((edge) => {
    const value = positions.get(roadmapIssueKey(edge.blocker));
    return value === undefined ? [] : [value];
  });
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : Number.MAX_SAFE_INTEGER;
}

function nodeHeight(title: string) {
  const estimatedLines = Math.min(3, Math.max(1, Math.ceil(title.length / 30)));
  return 112 + (estimatedLines - 1) * 18;
}

function goalGroups(goals: readonly RoadmapGoal[], nodes: readonly RoadmapLayoutNode[]) {
  return goals.flatMap((goal) => {
    const members = nodes.filter((node) => node.goalId === goal.id);
    if (members.length === 0) return [];
    const left = Math.min(...members.map((node) => node.position.x));
    const top = Math.min(...members.map((node) => node.position.y));
    const right = Math.max(...members.map((node) => node.position.x + node.dimensions.width));
    const bottom = Math.max(...members.map((node) => node.position.y + node.dimensions.height));
    return [{
      dimensions: {
        height: bottom - top + dimensions.groupLabelHeight + dimensions.groupVerticalPadding * 2,
        width: right - left + dimensions.groupHorizontalPadding * 2
      },
      goal,
      id: `roadmap:goal:${goal.id}`,
      position: {
        x: left - dimensions.groupHorizontalPadding,
        y: top - dimensions.groupLabelHeight - dimensions.groupVerticalPadding
      }
    }];
  });
}

function graphExtents(
  nodes: readonly RoadmapLayoutNode[],
  groups: readonly RoadmapLayoutGroup[]
) {
  const boxes = [...nodes, ...groups];
  if (boxes.length === 0) return { height: 1, width: 1, x: 0, y: 0 };
  const left = Math.min(...boxes.map((box) => box.position.x));
  const top = Math.min(...boxes.map((box) => box.position.y));
  const right = Math.max(...boxes.map((box) => box.position.x + box.dimensions.width));
  const bottom = Math.max(...boxes.map((box) => box.position.y + box.dimensions.height));
  return { height: bottom - top, width: right - left, x: left, y: top };
}

function translateLayout(
  nodes: readonly RoadmapLayoutNode[],
  groups: RoadmapLayoutGroup[],
  bounds: RoadmapLayout['bounds']
) {
  if (bounds.x === 0 && bounds.y === 0) return [...nodes];
  nodes.forEach((node) => {
    node.position = { x: node.position.x - bounds.x, y: node.position.y - bounds.y };
  });
  groups.forEach((group) => {
    group.position = { x: group.position.x - bounds.x, y: group.position.y - bounds.y };
  });
  bounds.x = 0;
  bounds.y = 0;
  return [...nodes];
}
