import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  DeployedEnvironmentStatusResult,
  GitHubPipelineStatusResult
} from '@/shared/project-space-api';
import { deploymentRuns } from '../components/deployment-status-model';

const refreshIntervalMs = 30_000;

export function useDeploymentOverview(repositoryFullName?: string, includeHistory = false) {
  const [environments, setEnvironments] = useState<DeployedEnvironmentStatusResult>();
  const [pipeline, setPipeline] = useState<GitHubPipelineStatusResult>();
  const [historyCommitShas, setHistoryCommitShas] = useState<ReadonlySet<string>>(new Set());
  const [requestFailed, setRequestFailed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const refreshing = useRef(false);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!repositoryFullName || refreshing.current) return;
    const generation = ++requestGeneration.current;
    refreshing.current = true;
    setIsRefreshing(true);
    setRequestFailed(false);

    const outcomes = await Promise.allSettled([
      projectSpaceClient.getDeployedEnvironmentStatus(repositoryFullName),
      projectSpaceClient.getGitHubPipelineStatus(repositoryFullName),
      includeHistory
        ? projectSpaceClient.getGitHubHistory({ fullName: repositoryFullName, limit: 250 })
        : Promise.resolve(undefined)
    ]);
    const [environmentOutcome, pipelineOutcome, historyOutcome] = outcomes;
    if (requestGeneration.current !== generation) return;

    if (environmentOutcome.status === 'fulfilled') {
      setEnvironments((current) => environmentOutcome.value.status === 'available' || !current
        ? environmentOutcome.value
        : current);
    }
    if (pipelineOutcome.status === 'fulfilled') {
      setPipeline((current) => pipelineOutcome.value.status === 'connected' || !current
        ? pipelineOutcome.value
        : current);
    }
    if (includeHistory && historyOutcome.status === 'fulfilled' && historyOutcome.value) {
      setHistoryCommitShas(new Set(
        historyOutcome.value.commits.map((commit) => commit.hash.toLowerCase())
      ));
    }

    setRequestFailed(
      environmentOutcome.status === 'rejected' ||
      (environmentOutcome.status === 'fulfilled' && environmentOutcome.value.status !== 'available') ||
      pipelineOutcome.status === 'rejected' ||
      (pipelineOutcome.status === 'fulfilled' && pipelineOutcome.value.status !== 'connected') ||
      (includeHistory && historyOutcome.status === 'rejected')
    );
    refreshing.current = false;
    setHasLoaded(true);
    setIsRefreshing(false);
  }, [includeHistory, repositoryFullName]);

  useEffect(() => {
    requestGeneration.current += 1;
    refreshing.current = false;
    setEnvironments(undefined);
    setPipeline(undefined);
    setHistoryCommitShas(new Set());
    setHasLoaded(false);
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, refreshIntervalMs);
    return () => {
      window.clearInterval(interval);
      requestGeneration.current += 1;
      refreshing.current = false;
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!repositoryFullName || !pipeline?.pagination?.hasNext || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const next = await projectSpaceClient.getGitHubPipelineStatus(repositoryFullName, {
        page: pipeline.pagination.page + 1,
        perPage: pipeline.pagination.perPage
      });
      if (next.status === 'connected') {
        setPipeline({
          ...next,
          runs: [
            ...pipeline.runs,
            ...next.runs.filter((run) => !pipeline.runs.some((current) => current.id === run.id))
          ]
        });
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, pipeline, repositoryFullName]);

  return {
    checkedAt: environments?.checkedAt ?? pipeline?.checkedAt,
    environments,
    hasLoaded,
    historyCommitShas,
    isRefreshing,
    isLoadingMore,
    loadMore,
    pipeline,
    refresh,
    requestFailed,
    runs: useMemo(() => deploymentRuns(pipeline?.runs ?? []), [pipeline?.runs])
  };
}
