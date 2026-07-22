import type { GitHubIssueRecord } from '../../shared/project-space-api';
import type {
  RoadmapDependency,
  RoadmapDependencyMutationRequest,
  RoadmapGoal,
  RoadmapIssueNode,
  RoadmapIssueReference,
  RoadmapPlanItemInput,
  RoadmapResult
} from '../../shared/roadmap-api';
import { roadmapIssueKey } from '../../shared/roadmap-model';

export function optimisticRoadmapPlan(
  result: RoadmapResult,
  goals: RoadmapGoal[],
  items: RoadmapPlanItemInput[],
  addedIssue?: GitHubIssueRecord
): RoadmapResult {
  const references = new Map<number, RoadmapIssueReference>();
  result.issues.forEach((node) => references.set(node.issue.number, node.issue));
  result.plan.items.forEach((item) => references.set(item.issue.number, item.issue));

  let issues = result.issues;
  if (addedIssue && !references.has(addedIssue.number)) {
    const reference = issueReference(result, addedIssue);
    references.set(addedIssue.number, reference);
    issues = [...issues, issueNode(addedIssue, reference)];
  }

  const plan = {
    ...result.plan,
    goals,
    items: items.flatMap((item) => {
      const issue = references.get(item.issueNumber);
      return issue ? [{ goalId: item.goalId, issue, plannedState: item.plannedState }] : [];
    })
  };
  const retainedIssueKeys = new Set(plan.items.map((item) => roadmapIssueKey(item.issue)));
  result.dependencies.forEach((dependency) => {
    retainedIssueKeys.add(roadmapIssueKey(dependency.blocker));
    retainedIssueKeys.add(roadmapIssueKey(dependency.blocked));
  });

  return {
    ...result,
    issues: issues.filter((node) => retainedIssueKeys.has(roadmapIssueKey(node.issue))),
    plan
  };
}

export function optimisticRoadmapDependency(
  result: RoadmapResult,
  operation: 'add' | 'remove',
  request: Omit<RoadmapDependencyMutationRequest, 'expectedGraphRevision' | 'fullName'>
): RoadmapResult {
  const blocked = referenceFor(result, result.repository.fullName, request.blockedIssueNumber);
  const blocker = referenceFor(
    result,
    request.blocker.fullName,
    request.blocker.issueNumber
  );
  const sameEdge = (edge: RoadmapDependency) => (
    roadmapIssueKey(edge.blocked) === roadmapIssueKey(blocked)
    && roadmapIssueKey(edge.blocker) === roadmapIssueKey(blocker)
  );
  const dependencies = operation === 'add'
    ? result.dependencies.some(sameEdge)
      ? result.dependencies
      : [...result.dependencies, { blocked, blocker, freshness: 'current' as const }]
    : result.dependencies.filter((edge) => !sameEdge(edge));
  const issues = ensureContextNode(result.issues, blocker, request.blocker.fullName);

  return {
    ...result,
    dependencies,
    issues: issues.map((node) => optimisticAvailability(node, issues, dependencies))
  };
}

export function roadmapDependencyMutationIssueIds(
  result: RoadmapResult,
  request: Omit<RoadmapDependencyMutationRequest, 'expectedGraphRevision' | 'fullName'>
) {
  return result.issues
    .filter((node) => (
      (node.issue.number === request.blockedIssueNumber
        && node.issue.fullName.toLowerCase() === result.repository.fullName.toLowerCase())
      || (node.issue.number === request.blocker.issueNumber
        && node.issue.fullName.toLowerCase() === request.blocker.fullName.toLowerCase())
    ))
    .map((node) => node.issue.id);
}

function issueReference(result: RoadmapResult, issue: GitHubIssueRecord): RoadmapIssueReference {
  return {
    fullName: result.repository.fullName,
    id: issue.id ?? -Math.max(1, issue.number),
    number: issue.number,
    url: issue.url
  };
}

function issueNode(issue: GitHubIssueRecord, reference: RoadmapIssueReference): RoadmapIssueNode {
  return {
    availability: issue.state === 'closed' ? 'closed' : 'ready',
    issue: reference,
    labels: issue.labels,
    state: issue.state,
    title: issue.title,
    updatedAt: issue.updatedAt
  };
}

function referenceFor(result: RoadmapResult, fullName: string, issueNumber: number) {
  return result.issues.find((node) => (
    node.issue.number === issueNumber
    && node.issue.fullName.toLowerCase() === fullName.toLowerCase()
  ))?.issue ?? {
    fullName,
    id: temporaryIssueId(fullName, issueNumber),
    number: issueNumber
  };
}

function temporaryIssueId(fullName: string, issueNumber: number) {
  let hash = 0;
  for (const character of fullName.toLowerCase()) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000_000;
  }
  return -(hash * 10_000 + issueNumber + 1);
}

function ensureContextNode(
  issues: readonly RoadmapIssueNode[],
  reference: RoadmapIssueReference,
  fullName: string
) {
  if (issues.some((node) => roadmapIssueKey(node.issue) === roadmapIssueKey(reference))) {
    return [...issues];
  }
  return [...issues, {
    availability: 'inaccessible' as const,
    issue: reference,
    labels: [],
    state: 'unknown' as const,
    title: `${fullName}#${reference.number}`
  }];
}

function optimisticAvailability(
  node: RoadmapIssueNode,
  issues: readonly RoadmapIssueNode[],
  dependencies: readonly RoadmapDependency[]
): RoadmapIssueNode {
  if (node.state === 'closed' || node.availability === 'inaccessible' || node.availability === 'missing') {
    return node;
  }
  const byKey = new Map(issues.map((entry) => [roadmapIssueKey(entry.issue), entry]));
  const blocked = dependencies.some((edge) => (
    roadmapIssueKey(edge.blocked) === roadmapIssueKey(node.issue)
    && byKey.get(roadmapIssueKey(edge.blocker))?.state !== 'closed'
  ));
  return { ...node, availability: blocked ? 'blocked' : 'ready' };
}
