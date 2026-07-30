import { useCallback, useEffect, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type {
  PullRequestPrototypeIterationRequest,
  PullRequestPrototypeIterationResult
} from '@/shared/pr-prototype-iteration-api';

const liveContextTimeoutMs = 8_000;

export function usePullRequestPrototypeIteration(
  request: PullRequestPrototypeIterationRequest | undefined
) {
  const [result, setResult] = useState<PullRequestPrototypeIterationResult>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    if (!request || document.hidden) return;
    const controller = new AbortController();
    let timeout: number | undefined;
    try {
      const next = await Promise.race([
        projectSpaceClient.getPullRequestPrototypeIteration(request, controller.signal),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => {
            controller.abort();
            reject(new Error('Live context verification timed out.'));
          }, liveContextTimeoutMs);
        })
      ]);
      setResult(next);
      setError(undefined);
    } catch (reason) {
      setResult(undefined);
      setError(reason instanceof Error ? reason.message : 'Live context is unavailable.');
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }, [request?.headSha, request?.pullRequestNumber, request?.repositoryFullName, request?.surface]);

  useEffect(() => {
    setResult(undefined);
    setError(undefined);
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    const onVisibilityChange = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [load]);

  const start = useCallback(async () => {
    if (!request || starting) return;
    setStarting(true);
    setError(undefined);
    try {
      setResult(await projectSpaceClient.startPullRequestPrototypeIteration(request));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start the development server.');
    } finally {
      setStarting(false);
    }
  }, [request?.headSha, request?.pullRequestNumber, request?.repositoryFullName, request?.surface, starting]);

  return { error, result, start, starting };
}
