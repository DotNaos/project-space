import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type { WorktreeSetupResult } from '@/shared/worktree-action-api';
import {
  addSetupOperation,
  removeSetupOperation,
  setupOperationKey
} from './worktree-setup-state';

const stablePollMs = 15_000;
const activePollMs = 2_000;
const emptySetupResults = new Map<string, WorktreeSetupResult>();
const emptySetupErrors = new Map<string, string>();
const emptyPendingSetupKeys = new Set<string>();

export function useWorktreeSetup({
  machineId,
  projectId,
  worktreeIds
}: {
  machineId?: string;
  projectId: string;
  worktreeIds: string[];
}) {
  const [results, setResults] = useState<Map<string, WorktreeSetupResult>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [isChecking, setIsChecking] = useState(false);
  const [stateRequestKey, setStateRequestKey] = useState('');
  const requestKey = `${machineId ?? ''}\u0000${projectId}\u0000${worktreeIds.join('\u0000')}`;
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;
  const scopedResults = stateRequestKey === requestKey ? results : emptySetupResults;
  const scopedErrors = stateRequestKey === requestKey ? errors : emptySetupErrors;
  const scopedPendingKeys = stateRequestKey === requestKey ? pendingKeys : emptyPendingSetupKeys;
  const scopedIsChecking = stateRequestKey === requestKey
    ? isChecking
    : Boolean(machineId && worktreeIds.length > 0);

  const refresh = useCallback(async () => {
    if (!machineId || worktreeIds.length === 0) {
      setStateRequestKey(requestKey);
      setResults(new Map());
      setIsChecking(false);
      return [];
    }

    const activeKey = requestKey;
    setStateRequestKey(activeKey);
    setIsChecking(true);
    try {
      const settled = await Promise.allSettled(
        worktreeIds.map((worktreeId) =>
          projectSpaceClient.inspectWorktreeSetup({ machineId, projectId, worktreeId })
        )
      );
      if (requestKeyRef.current !== activeKey) {
        return [];
      }

      const nextResults = new Map<string, WorktreeSetupResult>();
      const nextErrors = new Map<string, string>();
      settled.forEach((result, index) => {
        const worktreeId = worktreeIds[index]!;
        if (result.status === 'fulfilled') {
          nextResults.set(worktreeId, result.value);
        } else {
          nextErrors.set(worktreeId, 'Could not inspect trusted setup.');
        }
      });
      setResults(nextResults);
      setErrors(nextErrors);
      return Array.from(nextResults.values());
    } finally {
      if (requestKeyRef.current === activeKey) setIsChecking(false);
    }
  }, [machineId, projectId, requestKey, worktreeIds]);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResults(new Map());
    setErrors(new Map());
    setPendingKeys(new Set());
    setStateRequestKey(requestKey);

    async function poll() {
      const inspected = await refresh();
      if (canceled) return;
      const running = inspected.some((result) =>
        result.steps.some((step) => step.state === 'running')
      );
      timer = setTimeout(poll, running ? activePollMs : stablePollMs);
    }
    void poll();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const prepare = useCallback(
    async (worktreeId: string, setupStepId: string) => {
      if (!machineId) return;
      const activeKey = requestKey;
      const operationKey = setupOperationKey(worktreeId, setupStepId);
      setStateRequestKey(activeKey);
      setPendingKeys((current) => addSetupOperation(current, operationKey));
      try {
        const result = await projectSpaceClient.runWorktreeSetup({
          machineId,
          projectId,
          setupStepId,
          worktreeId
        });
        if (requestKeyRef.current !== activeKey) return;
        setResults((current) => new Map(current).set(worktreeId, result));
        setErrors((current) => {
          const next = new Map(current);
          next.delete(worktreeId);
          return next;
        });
      } catch {
        if (requestKeyRef.current !== activeKey) return;
        setErrors((current) =>
          new Map(current).set(worktreeId, 'Trusted setup did not complete. You can retry it safely.')
        );
        await refresh();
      } finally {
        if (requestKeyRef.current === activeKey) {
          setPendingKeys((current) => removeSetupOperation(current, operationKey));
        }
      }
    },
    [machineId, projectId, refresh, requestKey]
  );

  return useMemo(
    () => ({
      errors: scopedErrors,
      isChecking: scopedIsChecking,
      pendingKeys: scopedPendingKeys,
      prepare,
      refresh,
      results: scopedResults
    }),
    [prepare, refresh, scopedErrors, scopedIsChecking, scopedPendingKeys, scopedResults]
  );
}
