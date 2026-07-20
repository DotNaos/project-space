import { useEffect, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import {
  roadmapIssueLoadForRepository,
  type RoadmapIssueLoad
} from './roadmap-issue-picker-model';

export function useRoadmapIssues(fullName?: string) {
  const [loaded, setLoaded] = useState<RoadmapIssueLoad>();
  const [isLoading, setIsLoading] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!fullName) {
      setLoaded(undefined);
      setIsLoading(false);
      return;
    }
    let canceled = false;
    setIsLoading(true);
    projectSpaceClient.getGitHubRepositoryDetails(fullName)
      .then((details) => {
        if (canceled) return;
        setLoaded({
          error: details.status === 'connected'
            ? ''
            : details.message ?? 'Issues are unavailable.',
          fullName,
          issues: details.issues
        });
      })
      .catch((reason) => {
        if (!canceled) setLoaded({
          error: reason instanceof Error ? reason.message : 'Could not load repository issues.',
          fullName,
          issues: []
        });
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [fullName, generation]);

  const current = roadmapIssueLoadForRepository(loaded, fullName);
  return {
    error: current?.error ?? '',
    isLoading,
    issues: current?.issues ?? [],
    refresh: () => setGeneration((value) => value + 1)
  };
}
