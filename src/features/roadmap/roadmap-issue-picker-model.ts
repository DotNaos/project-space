import type { GitHubIssueRecord } from '../../shared/project-space-api';

export interface RoadmapIssueLoad {
  error: string;
  fullName: string;
  issues: GitHubIssueRecord[];
}

export function filterRoadmapIssues(
  issues: readonly GitHubIssueRecord[],
  query: string,
  excludedNumbers: ReadonlySet<number>
) {
  const normalized = query.trim().toLowerCase().replace(/^#/, '');
  return issues
    .filter((issue) => !excludedNumbers.has(issue.number))
    .filter((issue) => !normalized || [
      String(issue.number),
      issue.title,
      ...issue.labels
    ].some((value) => value.toLowerCase().includes(normalized)))
    .sort((left, right) => (
      Number(left.state === 'closed') - Number(right.state === 'closed')
      || right.number - left.number
    ))
    .slice(0, 40);
}

export function roadmapIssueLoadForRepository(
  loaded: RoadmapIssueLoad | undefined,
  fullName: string | undefined
) {
  return loaded?.fullName.toLowerCase() === fullName?.toLowerCase() ? loaded : undefined;
}
