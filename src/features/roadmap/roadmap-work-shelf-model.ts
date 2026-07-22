import type { GitHubIssueRecord } from '../../shared/project-space-api';
import type { RoadmapIssueReference, RoadmapResult } from '../../shared/roadmap-api';
import {
  roadmapAdditionIndex,
  roadmapIssueKey,
  validRoadmapAdditionRange,
  validRoadmapMoveRange
} from '../../shared/roadmap-model';

export function roadmapWorkShelfIssues(
  issues: readonly GitHubIssueRecord[],
  result: Pick<RoadmapResult, 'plan'>,
  query: string
) {
  const plannedNumbers = new Set(result.plan.items.map((item) => item.issue.number));
  const normalized = query.trim().toLowerCase().replace(/^#/, '');

  return issues
    .filter((issue) => !plannedNumbers.has(issue.number))
    .filter((issue) => !normalized || [
      String(issue.number),
      issue.title,
      ...issue.labels
    ].some((value) => value.toLowerCase().includes(normalized)))
    .sort((left, right) => (
      Number(left.state === 'closed') - Number(right.state === 'closed')
      || right.number - left.number
    ));
}

export function roadmapWorkShelfAdditionIndex(
  result: RoadmapResult,
  issue: Pick<GitHubIssueRecord, 'number'>
) {
  const contextualIssue = result.issues.find((node) => (
    node.issue.number === issue.number
    && node.issue.fullName.toLowerCase() === result.repository.fullName.toLowerCase()
  ));

  return contextualIssue
    ? roadmapAdditionIndex(result.plan.items, result.dependencies, contextualIssue.issue)
    : result.plan.items.length;
}

export function roadmapWorkShelfAdditionRange(
  result: RoadmapResult,
  issue: Pick<GitHubIssueRecord, 'number'>
) {
  const contextualIssue = result.issues.find((node) => (
    node.issue.number === issue.number
    && node.issue.fullName.toLowerCase() === result.repository.fullName.toLowerCase()
  ));
  return contextualIssue
    ? validRoadmapAdditionRange(result.plan.items, result.dependencies, contextualIssue.issue)
    : { maximum: result.plan.items.length, minimum: 0 };
}

export function roadmapWorkShelfInsertionIndex(
  result: RoadmapResult,
  issue: Pick<GitHubIssueRecord, 'number'>,
  verticalProgress: number
) {
  const contextualIssue = result.issues.find((node) => (
    node.issue.number === issue.number
    && node.issue.fullName.toLowerCase() === result.repository.fullName.toLowerCase()
  ));
  const range = contextualIssue
    ? validRoadmapAdditionRange(result.plan.items, result.dependencies, contextualIssue.issue)
    : { maximum: result.plan.items.length, minimum: 0 };
  if (!range) return undefined;
  const desired = Math.round(Math.max(0, Math.min(1, verticalProgress)) * result.plan.items.length);
  return Math.max(range.minimum, Math.min(range.maximum, desired));
}

export function roadmapWorkShelfPlanLabel(index: number | undefined) {
  return index === undefined ? 'Unavailable' : `Plan ${String(index + 1).padStart(2, '0')}`;
}

export function roadmapAdditionPositionLabel(result: RoadmapResult, index: number) {
  if (index === 0) return 'Beginning';
  if (index === result.plan.items.length) return 'End';
  return `Before #${result.plan.items[index]?.issue.number}`;
}

export function roadmapSpatialMoveIndex(
  result: RoadmapResult,
  issue: RoadmapIssueReference,
  verticalProgress: number
) {
  const range = validRoadmapMoveRange(result.plan.items, result.dependencies, issue);
  if (!range) return undefined;
  const desired = Math.round(
    Math.max(0, Math.min(1, verticalProgress)) * Math.max(0, result.plan.items.length - 1)
  );
  return Math.max(range.minimum, Math.min(range.maximum, desired));
}

export function roadmapMovePositionLabel(
  result: RoadmapResult,
  issue: RoadmapIssueReference,
  index: number
) {
  const others = result.plan.items.filter(
    (item) => roadmapIssueKey(item.issue) !== roadmapIssueKey(issue)
  );
  if (index === 0) return 'Beginning';
  if (index === others.length) return 'End';
  return `Before #${others[index]?.issue.number}`;
}

export function pointIsInsideElement(
  point: { x: number; y: number },
  element: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>
) {
  return point.x >= element.left
    && point.x <= element.right
    && point.y >= element.top
    && point.y <= element.bottom;
}
