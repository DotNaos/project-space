import { useCallback, useEffect, useRef, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubCodespaceInventoryResult } from '@/shared/github-codespace-inventory-api';
import type {
  TailscaleDeviceClassification,
  TailscaleInventoryDevice,
  TailscaleInventoryResult
} from '@/shared/tailscale-inventory-api';
export type { ComputeSourceStatus, ComputeSourceState } from './use-compute-sources-types';
export {
  computeSourceErrorState,
  computeSourceLoadingState,
  computeSourceReadyState,
  computeTailscaleSourceErrorState,
  createComputeSourceRequestGate,
  mergeTailscaleRefreshResult
} from './compute-source-state';
import {
  computeSourceErrorState,
  computeSourceLoadingState,
  computeSourceReadyState,
  computeTailscaleSourceErrorState,
  createComputeSourceRequestGate,
  mergeTailscaleRefreshResult
} from './compute-source-state';
import type { ComputeSourceState } from './use-compute-sources-types';

const refreshIntervalMs = 60_000;

export function useComputeSources() {
  const [tailscale, setTailscale] = useState<ComputeSourceState<TailscaleInventoryResult>>({
    error: '',
    status: 'loading'
  });
  const [github, setGitHub] = useState<ComputeSourceState<GitHubCodespaceInventoryResult>>({
    error: '',
    status: 'loading'
  });
  const tailscaleRequests = useRef(createComputeSourceRequestGate());
  const githubRequests = useRef(createComputeSourceRequestGate());

  const refreshTailscale = useCallback(async (forceRefresh = true) => {
    const request = tailscaleRequests.current.begin();
    setTailscale(computeSourceLoadingState);
    try {
      const result = await projectSpaceClient.getTailscaleInventory(forceRefresh);
      if (!tailscaleRequests.current.isLatest(request)) return result;
      setTailscale((current) => computeSourceReadyState(mergeTailscaleRefreshResult(current.result, result)));
      return result;
    } catch {
      if (!tailscaleRequests.current.isLatest(request)) return undefined;
      setTailscale((current) => computeTailscaleSourceErrorState(current, 'Tailscale inventory could not be refreshed.'));
      return undefined;
    }
  }, []);

  const refreshGitHub = useCallback(async () => {
    const request = githubRequests.current.begin();
    setGitHub(computeSourceLoadingState);
    try {
      const result = await projectSpaceClient.getGitHubCodespaceInventory();
      if (!githubRequests.current.isLatest(request)) return result;
      setGitHub(computeSourceReadyState(result));
      return result;
    } catch {
      if (!githubRequests.current.isLatest(request)) return undefined;
      setGitHub((current) => computeSourceErrorState(current, 'GitHub Codespaces could not be refreshed.'));
      return undefined;
    }
  }, []);

  useEffect(() => {
    void Promise.allSettled([refreshTailscale(true), refreshGitHub()]);
    const tailscaleInterval = window.setInterval(() => {
      void refreshTailscale(true);
    }, refreshIntervalMs);
    const githubInterval = window.setInterval(() => {
      void refreshGitHub();
    }, refreshIntervalMs);
    return () => {
      window.clearInterval(tailscaleInterval);
      window.clearInterval(githubInterval);
    };
  }, [refreshGitHub, refreshTailscale]);

  const classifyTailscaleDevice = useCallback(async (
    device: TailscaleInventoryDevice,
    classification: TailscaleDeviceClassification
  ) => {
    const saved = await projectSpaceClient.setTailscaleDeviceClassification(device.id, {
      classification,
      expectedRevision: device.revision
    });
    setTailscale((current) => current.result ? {
      ...current,
      result: {
        ...current.result,
        devices: current.result.devices.map((entry) => entry.id === device.id
          ? { ...entry, classification: saved.classification, revision: saved.revision }
          : entry)
      }
    } : current);
    return saved;
  }, []);

  return {
    classifyTailscaleDevice,
    github,
    refreshGitHub,
    refreshTailscale,
    tailscale
  };
}
