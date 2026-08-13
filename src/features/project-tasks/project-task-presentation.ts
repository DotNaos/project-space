import type { GitHubPullRequestRecord } from '@/shared/project-space-api';

export function pullRequestChipPresentation(pullRequest: GitHubPullRequestRecord) {
  if (pullRequest.state === 'merged') {
    return {
      className: '!bg-violet-500',
      color: 'default' as const,
      icon: 'merged' as const,
      label: `Merged PR #${pullRequest.number}`
    };
  }
  if (pullRequest.state === 'open' && !pullRequest.isDraft) {
    return {
      className: undefined,
      color: 'success' as const,
      icon: 'open' as const,
      label: `Open PR #${pullRequest.number}`
    };
  }
  return {
    className: '!bg-neutral-600',
    color: 'default' as const,
    icon: pullRequest.isDraft ? 'draft' as const : 'closed' as const,
    label: `${pullRequest.isDraft ? 'Draft' : 'Closed'} PR #${pullRequest.number}`
  };
}
