import type {
  RoadmapDependency,
  RoadmapGoal,
  RoadmapIssueReference,
  RoadmapPlanItem
} from './roadmap-api';
import { createHash } from './stable-hash';

export function roadmapIssueKey(issue: Pick<RoadmapIssueReference, 'fullName' | 'id'>) {
  return String(issue.id);
}

export function roadmapGraphRevision(dependencies: readonly RoadmapDependency[]) {
  const signature = dependencies
    .map((dependency) => (
      `${roadmapIssueKey(dependency.blocker)}>${roadmapIssueKey(dependency.blocked)}`
    ))
    .sort()
    .join('\n');
  return createHash(signature);
}

export function roadmapDependencyCycle(
  dependencies: readonly RoadmapDependency[],
  candidate?: Pick<RoadmapDependency, 'blocked' | 'blocker'>
) {
  const edges = candidate
    ? [...dependencies, { ...candidate, freshness: 'current' as const }]
    : dependencies;
  const outgoing = new Map<string, Set<string>>();
  for (const edge of edges) {
    const blocker = roadmapIssueKey(edge.blocker);
    const blocked = roadmapIssueKey(edge.blocked);
    const targets = outgoing.get(blocker) ?? new Set<string>();
    targets.add(blocked);
    outgoing.set(blocker, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const target of outgoing.get(key) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return [...outgoing.keys()].some(visit);
}

export function roadmapCyclicIssueKeys(dependencies: readonly RoadmapDependency[]) {
  const outgoing = new Map<string, Set<string>>();
  for (const edge of dependencies) {
    const blocker = roadmapIssueKey(edge.blocker);
    const blocked = roadmapIssueKey(edge.blocked);
    outgoing.set(blocker, (outgoing.get(blocker) ?? new Set()).add(blocked));
  }
  const cyclic = new Set<string>();
  const returnsTo = (start: string, key: string, visited: Set<string>): boolean => {
    for (const target of outgoing.get(key) ?? []) {
      if (target === start) return true;
      if (visited.has(target)) continue;
      visited.add(target);
      if (returnsTo(start, target, visited)) return true;
    }
    return false;
  };
  outgoing.forEach((_, key) => {
    if (returnsTo(key, key, new Set([key]))) cyclic.add(key);
  });
  return cyclic;
}

export function roadmapOrderViolations(
  items: readonly RoadmapPlanItem[],
  dependencies: readonly RoadmapDependency[]
) {
  const positions = new Map(
    items.map((item, index) => [roadmapIssueKey(item.issue), index])
  );
  return dependencies.filter((dependency) => {
    const blocker = positions.get(roadmapIssueKey(dependency.blocker));
    const blocked = positions.get(roadmapIssueKey(dependency.blocked));
    return blocker !== undefined && blocked !== undefined && blocker >= blocked;
  });
}

export function validRoadmapMoveRange(
  items: readonly RoadmapPlanItem[],
  dependencies: readonly RoadmapDependency[],
  issue: RoadmapIssueReference
) {
  const currentIndex = items.findIndex(
    (item) => roadmapIssueKey(item.issue) === roadmapIssueKey(issue)
  );
  if (currentIndex < 0) return undefined;
  const otherItems = items.filter((_, index) => index !== currentIndex);
  const positions = new Map(
    otherItems.map((item, index) => [roadmapIssueKey(item.issue), index])
  );
  let minimum = 0;
  let maximum = otherItems.length;
  for (const dependency of dependencies) {
    if (roadmapIssueKey(dependency.blocked) === roadmapIssueKey(issue)) {
      const blocker = positions.get(roadmapIssueKey(dependency.blocker));
      if (blocker !== undefined) minimum = Math.max(minimum, blocker + 1);
    }
    if (roadmapIssueKey(dependency.blocker) === roadmapIssueKey(issue)) {
      const blocked = positions.get(roadmapIssueKey(dependency.blocked));
      if (blocked !== undefined) maximum = Math.min(maximum, blocked);
    }
  }
  return { maximum, minimum };
}

export function roadmapAdditionIndex(
  items: readonly RoadmapPlanItem[],
  dependencies: readonly RoadmapDependency[],
  issue: RoadmapIssueReference
) {
  const positions = new Map(
    items.map((item, index) => [roadmapIssueKey(item.issue), index])
  );
  let minimum = 0;
  let maximum = items.length;
  for (const dependency of dependencies) {
    if (roadmapIssueKey(dependency.blocked) === roadmapIssueKey(issue)) {
      const blocker = positions.get(roadmapIssueKey(dependency.blocker));
      if (blocker !== undefined) minimum = Math.max(minimum, blocker + 1);
    }
    if (roadmapIssueKey(dependency.blocker) === roadmapIssueKey(issue)) {
      const blocked = positions.get(roadmapIssueKey(dependency.blocked));
      if (blocked !== undefined) maximum = Math.min(maximum, blocked);
    }
  }
  return minimum <= maximum ? maximum : undefined;
}

export function moveRoadmapItem(
  items: readonly RoadmapPlanItem[],
  issue: RoadmapIssueReference,
  targetIndex: number,
  dependencies: readonly RoadmapDependency[]
) {
  const currentIndex = items.findIndex(
    (item) => roadmapIssueKey(item.issue) === roadmapIssueKey(issue)
  );
  const range = validRoadmapMoveRange(items, dependencies, issue);
  if (currentIndex < 0 || !range || targetIndex < range.minimum || targetIndex > range.maximum) {
    return undefined;
  }
  const next = [...items];
  const [moved] = next.splice(currentIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function normalizedRoadmapGoals(goals: readonly RoadmapGoal[]) {
  const seen = new Set<string>();
  return goals.flatMap((goal) => {
    const id = goal.id.trim();
    const title = goal.title.trim();
    const normalizedId = id.toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)
      || !title
      || title.length > 120
      || seen.has(normalizedId)
    ) return [];
    seen.add(normalizedId);
    return [{
      id,
      title,
      ...(goal.description?.trim() ? { description: goal.description.trim() } : {})
    }];
  });
}
