import { useCallback, useEffect, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type { PullRequestTestSurfacesResult } from '@/shared/pr-preview-test-surfaces-api';

export function usePullRequestPrototypeLaunch(options: {
  enabled: boolean;
  pullRequestNumber?: number;
  repositoryFullName?: string;
}) {
  const { enabled, pullRequestNumber, repositoryFullName } = options;
  const [result, setResult] = useState<PullRequestTestSurfacesResult>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled || !pullRequestNumber || !repositoryFullName) return;
    setIsLoading(true);
    try {
      const next = await projectSpaceClient.getPullRequestTestSurfaces(
        repositoryFullName,
        pullRequestNumber
      );
      setResult(next);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : 'Prototype availability could not be verified.');
    } finally {
      setIsLoading(false);
    }
  }, [enabled, pullRequestNumber, repositoryFullName]);

  useEffect(() => {
    setResult(undefined);
    setError(undefined);
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return {
    error,
    isLoading: isLoading || (enabled && !result && !error),
    refresh,
    result
  };
}
