import type {
  GitHubBranchComparisonResult,
  GitHubBranchComparisonState
} from '@/shared/project-space-api';

export interface BranchHeadComparisonPresentation {
  actionRequired: boolean;
  label: string;
  tone: 'success' | 'warning';
}

export function branchHeadComparisonPresentation(input: {
  aheadBy: number;
  behindBy: number;
  state: GitHubBranchComparisonState;
}): BranchHeadComparisonPresentation {
  if (input.state === 'diverged') {
    return {
      actionRequired: true,
      label: `Diverged — ${input.aheadBy} ahead, ${input.behindBy} behind; action required`,
      tone: 'warning'
    };
  }
  if (input.state === 'behind') {
    return {
      actionRequired: true,
      label: `Behind by ${input.behindBy} — action required`,
      tone: 'warning'
    };
  }
  if (input.state === 'ahead') {
    return {
      actionRequired: false,
      label: `Ahead by ${input.aheadBy}`,
      tone: 'success'
    };
  }
  return {
    actionRequired: false,
    label: 'Up to date',
    tone: 'success'
  };
}

export function comparisonHasRenderableGraph(
  result: GitHubBranchComparisonResult
): result is GitHubBranchComparisonResult & {
  aheadBy: number;
  behindBy: number;
  defaultBranch: NonNullable<GitHubBranchComparisonResult['defaultBranch']>;
  head: NonNullable<GitHubBranchComparisonResult['head']>;
  state: NonNullable<GitHubBranchComparisonResult['state']>;
} {
  return Boolean(
    result.status === 'connected' &&
    result.freshness === 'current' &&
    result.head &&
    result.defaultBranch &&
    result.state &&
    typeof result.aheadBy === 'number' &&
    typeof result.behindBy === 'number' &&
    result.commits.length > 0
  );
}
