import type {
  RoadmapDependency,
  RoadmapIssueNode,
  RoadmapPlan,
  RoadmapPlanItem,
  RoadmapResult
} from '../../shared/roadmap-api';
import {
  moveRoadmapItem,
  normalizedRoadmapGoals,
  roadmapAdditionIndex,
  roadmapDependencyCycle,
  roadmapGraphRevision,
  roadmapIssueKey,
  roadmapOrderViolations,
  validRoadmapMoveRange
} from '../../shared/roadmap-model';

export {
  moveRoadmapItem,
  normalizedRoadmapGoals,
  roadmapAdditionIndex,
  roadmapDependencyCycle,
  roadmapGraphRevision,
  roadmapOrderViolations,
  validRoadmapMoveRange
};

export interface RoadmapStoryNode {
  depth: number;
  issue: RoadmapIssueNode;
  planItem?: RoadmapPlanItem;
  position: number;
}

export interface RoadmapStory {
  edges: RoadmapDependency[];
  nodes: RoadmapStoryNode[];
}

export interface RoadmapGraphVisibility {
  completedCount: number;
  dependencies: RoadmapDependency[];
  issues: RoadmapIssueNode[];
}

export function roadmapGraphVisibility(
  result: RoadmapResult,
  showCompleted: boolean
): RoadmapGraphVisibility {
  const completedCount = result.issues.filter((issue) => issue.state === 'closed').length;
  if (showCompleted || completedCount === 0) {
    return {
      completedCount,
      dependencies: result.dependencies,
      issues: result.issues
    };
  }
  const openIssues = result.issues.filter((issue) => issue.state !== 'closed');
  const openIssueKeys = new Set(openIssues.map((issue) => roadmapIssueKey(issue.issue)));
  const openDependencies = result.dependencies.filter((dependency) => (
    openIssueKeys.has(roadmapIssueKey(dependency.blocker))
    && openIssueKeys.has(roadmapIssueKey(dependency.blocked))
  ));
  const connectedIssueKeys = connectedRoadmapIssues(
    result.plan.items
      .map((item) => roadmapIssueKey(item.issue))
      .filter((key) => openIssueKeys.has(key)),
    openDependencies
  );
  return {
    completedCount,
    dependencies: openDependencies.filter((dependency) => (
      connectedIssueKeys.has(roadmapIssueKey(dependency.blocker))
      && connectedIssueKeys.has(roadmapIssueKey(dependency.blocked))
    )),
    issues: openIssues.filter((issue) => connectedIssueKeys.has(roadmapIssueKey(issue.issue)))
  };
}

function connectedRoadmapIssues(
  plannedKeys: readonly string[],
  dependencies: readonly RoadmapDependency[]
) {
  const connected = new Set(plannedKeys);
  const adjacent = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const blocker = roadmapIssueKey(dependency.blocker);
    const blocked = roadmapIssueKey(dependency.blocked);
    adjacent.set(blocker, [...(adjacent.get(blocker) ?? []), blocked]);
    adjacent.set(blocked, [...(adjacent.get(blocked) ?? []), blocker]);
  }
  const queue = [...plannedKeys];
  while (queue.length > 0) {
    const key = queue.shift();
    if (!key) continue;
    for (const neighbor of adjacent.get(key) ?? []) {
      if (connected.has(neighbor)) continue;
      connected.add(neighbor);
      queue.push(neighbor);
    }
  }
  return connected;
}

export function buildRoadmapStory(
  plan: RoadmapPlan,
  issues: readonly RoadmapIssueNode[],
  dependencies: readonly RoadmapDependency[]
): RoadmapStory {
  const issuesByKey = new Map(issues.map((issue) => [roadmapIssueKey(issue.issue), issue]));
  const planItemsByKey = new Map(
    plan.items.map((item) => [roadmapIssueKey(item.issue), item])
  );
  const incoming = new Map<string, string[]>();
  for (const edge of dependencies) {
    const blocked = roadmapIssueKey(edge.blocked);
    const blocker = roadmapIssueKey(edge.blocker);
    if (!issuesByKey.has(blocked) || !issuesByKey.has(blocker)) continue;
    incoming.set(blocked, [...(incoming.get(blocked) ?? []), blocker]);
  }
  const depthMemo = new Map<string, number>();
  const depthFor = (key: string, path = new Set<string>()): number => {
    if (depthMemo.has(key)) return depthMemo.get(key) ?? 0;
    if (path.has(key)) return 0;
    const nextPath = new Set(path).add(key);
    const depth = Math.max(0, ...(incoming.get(key) ?? []).map((parent) => depthFor(parent, nextPath) + 1));
    depthMemo.set(key, depth);
    return depth;
  };
  return {
    edges: dependencies.filter((edge) => (
      issuesByKey.has(roadmapIssueKey(edge.blocker))
      && issuesByKey.has(roadmapIssueKey(edge.blocked))
    )),
    nodes: [...issuesByKey.values()].map((issue) => {
      const key = roadmapIssueKey(issue.issue);
      const planItem = planItemsByKey.get(key);
      const planPosition = plan.items.findIndex((item) => roadmapIssueKey(item.issue) === key);
      return {
        depth: depthFor(key),
        issue,
        planItem,
        position: planPosition >= 0 ? planPosition : plan.items.length + issue.issue.number
      };
    }).sort((left, right) => left.depth - right.depth || left.position - right.position)
  };
}

export function nextRoadmapPlanEntry(
  plan: RoadmapPlan,
  issues: readonly RoadmapIssueNode[]
) {
  const issuesByKey = new Map(issues.map((issue) => [roadmapIssueKey(issue.issue), issue]));
  const ordered = plan.items.map((item) => ({
    issue: issuesByKey.get(roadmapIssueKey(item.issue)),
    item
  }));
  return ordered.find((entry) => (
    entry.item.plannedState === 'active' && entry.issue?.availability === 'ready'
  )) ?? ordered.find((entry) => entry.issue?.availability === 'ready');
}
