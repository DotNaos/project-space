import { useCallback, useEffect, useRef, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  TailscaleDeviceClassification,
  TailscaleHostAssignmentRequest,
  TailscaleInventoryDevice,
  TailscaleInventoryResult
} from '@/shared/tailscale-inventory-api';

export type TailnetInventoryStatus = 'error' | 'loading' | 'ready' | 'refreshing';
export type TailnetHostAssignmentDraft =
  | { action: 'assign'; hostId: string }
  | { action: 'create'; name: string }
  | { action: 'unassign' };

const refreshIntervalMs = 60_000;

export function useTailnetComputeInventory(onComputeRefresh: () => Promise<unknown>) {
  const [result, setResult] = useState<TailscaleInventoryResult>();
  const [status, setStatus] = useState<TailnetInventoryStatus>('loading');
  const [error, setError] = useState('');
  const requestGeneration = useRef(0);

  const refresh = useCallback(async (forceRefresh = true) => {
    const request = requestGeneration.current + 1;
    requestGeneration.current = request;
    setStatus((current) => current === 'loading' ? 'loading' : 'refreshing');
    setError('');
    try {
      const next = await projectSpaceClient.getTailscaleInventory(forceRefresh);
      if (request !== requestGeneration.current) return undefined;
      setResult(next);
      setStatus('ready');
      return next;
    } catch {
      if (request !== requestGeneration.current) return undefined;
      setError('Tailnet inventory could not be refreshed.');
      setStatus('error');
      return undefined;
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => void refresh(true), refreshIntervalMs);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const classify = useCallback(async (
    device: TailscaleInventoryDevice,
    classification: TailscaleDeviceClassification
  ) => {
    await projectSpaceClient.setTailscaleDeviceClassification(device.id, {
      classification,
      expectedRevision: device.revision
    });
    await Promise.allSettled([refresh(true), onComputeRefresh()]);
  }, [onComputeRefresh, refresh]);

  const assignHost = useCallback(async (
    device: TailscaleInventoryDevice,
    request: TailnetHostAssignmentDraft
  ) => {
    await projectSpaceClient.setTailscaleDeviceHost(device.id, {
      ...request,
      expectedRevision: device.hostAssignmentRevision
    } as TailscaleHostAssignmentRequest);
    await Promise.allSettled([refresh(true), onComputeRefresh()]);
  }, [onComputeRefresh, refresh]);

  return { assignHost, classify, error, refresh, result, status };
}
