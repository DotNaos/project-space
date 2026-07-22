import type { GitHubIssueRecord } from '../../shared/project-space-api';
import type { RoadmapResult } from '../../shared/roadmap-api';
import { roadmapAdditionIndex } from '../../shared/roadmap-model';

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

export function roadmapWorkShelfPlanLabel(index: number | undefined) {
  return index === undefined ? 'Unavailable' : `Plan ${String(index + 1).padStart(2, '0')}`;
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
