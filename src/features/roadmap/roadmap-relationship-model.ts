import type { GitHubIssueRecord } from '../../shared/project-space-api';
import type {
  RoadmapDependencyMutationRequest,
  RoadmapIssueNode,
  RoadmapResult
} from '../../shared/roadmap-api';

export type RoadmapRelationshipDirection = 'prerequisite' | 'successor';
export type RoadmapRelationshipRequest = Omit<
  RoadmapDependencyMutationRequest,
  'expectedGraphRevision' | 'fullName'
>;

export function roadmapRelationshipRequest(
  direction: RoadmapRelationshipDirection,
  selected: RoadmapIssueNode,
  issueNumber: number,
  prerequisiteRepository: string
): RoadmapRelationshipRequest {
  return direction === 'prerequisite'
    ? {
        blockedIssueNumber: selected.issue.number,
        blocker: { fullName: prerequisiteRepository.trim(), issueNumber }
      }
    : {
        blockedIssueNumber: issueNumber,
        blocker: {
          fullName: selected.issue.fullName,
          issueNumber: selected.issue.number
        }
      };
}

export function roadmapPlannedSuccessorCandidates(result: RoadmapResult) {
  const nodes = new Map(result.issues.map((node) => [node.issue.id, node]));
  return result.plan.items.flatMap<GitHubIssueRecord>((item) => {
    const node = nodes.get(item.issue.id);
    if (
      !node
      || node.issue.fullName.toLowerCase() !== result.repository.fullName.toLowerCase()
      || node.state === 'unknown'
    ) return [];
    return [{
      id: node.issue.id,
      labels: node.labels,
      number: node.issue.number,
      state: node.state,
      title: node.title,
      updatedAt: node.updatedAt,
      url: node.issue.url ?? `https://github.com/${node.issue.fullName}/issues/${node.issue.number}`
    }];
  });
}
