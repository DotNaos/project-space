import { useCallback, useEffect, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type { CodexMachineTaskStartResult } from '@/shared/codex-machine-tasks-api';
import type { PullRequestTestSurfacesResult } from '@/shared/pr-preview-test-surfaces-api';

export function usePullRequestPrototypeLaunch(options: {
  branchName?: string;
  connectorId?: string;
  enabled: boolean;
  headSha?: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  repositoryFullName?: string;
}) {
  const {
    branchName,
    connectorId,
    enabled,
    headSha,
    issueNumber,
    pullRequestNumber,
    repositoryFullName
  } = options;
  const [result, setResult] = useState<PullRequestTestSurfacesResult>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [startResult, setStartResult] = useState<CodexMachineTaskStartResult>();

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
    setStartResult(undefined);
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const startOrReuseTask = useCallback(async () => {
    if (!branchName || !headSha || !issueNumber || !repositoryFullName) return;
    setIsStarting(true);
    setError(undefined);
    try {
      const next = await projectSpaceClient.startCodexMachineTask({
        connectorId,
        expectedBranch: branchName,
        expectedCommit: headSha,
        expectedPullRequestNumber: pullRequestNumber,
        issue: issueNumber,
        operationId: `prototype:${globalThis.crypto.randomUUID()}`,
        repositoryId: repositoryFullName
      });
      setStartResult(next);
      if (next.state === 'blocked' || next.state === 'uncertain') {
        setError(next.message);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : 'The prototype task could not be started.');
    } finally {
      setIsStarting(false);
    }
  }, [
    branchName,
    connectorId,
    headSha,
    issueNumber,
    pullRequestNumber,
    refresh,
    repositoryFullName
  ]);

  return {
    error,
    isLoading: isLoading || (enabled && !result && !error),
    isStarting,
    refresh,
    result,
    startOrReuseTask,
    startResult
  };
}
