import { useEffect, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubBranchComparisonResult } from '@/shared/project-space-api';

export type BranchHeadComparisonLoadState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { result: GitHubBranchComparisonResult; state: 'ready' };

export function useBranchHeadComparison(input: {
  enabled: boolean;
  expectedHeadSha?: string;
  headBranch?: string;
  repositoryFullName?: string;
}) {
  const [loadState, setLoadState] = useState<BranchHeadComparisonLoadState>({ state: 'idle' });

  useEffect(() => {
    if (!input.enabled || !input.headBranch || !input.repositoryFullName) {
      setLoadState({ state: 'idle' });
      return;
    }

    let canceled = false;
    setLoadState({ state: 'loading' });
    projectSpaceClient.getGitHubBranchComparison({
      expectedHeadSha: input.expectedHeadSha,
      fullName: input.repositoryFullName,
      headBranch: input.headBranch,
      limit: 8
    }).then((result) => {
      if (!canceled) setLoadState({ result, state: 'ready' });
    }).catch(() => {
      if (!canceled) {
        setLoadState({
          result: {
            checkedAt: new Date().toISOString(),
            commits: [],
            freshness: 'unavailable',
            mergeBaseIncluded: false,
            message: 'Could not compare the linked branch.',
            reason: 'history-unavailable',
            status: 'error',
            truncated: false
          },
          state: 'ready'
        });
      }
    });

    return () => {
      canceled = true;
    };
  }, [
    input.enabled,
    input.expectedHeadSha,
    input.headBranch,
    input.repositoryFullName
  ]);

  return loadState;
}
