import { useCallback, useEffect, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubCodespaceInventoryResult } from '@/shared/github-codespace-inventory-api';
import type {
  TailscaleDeviceClassification,
  TailscaleInventoryDevice,
  TailscaleInventoryResult
} from '@/shared/tailscale-inventory-api';

export type ComputeSourceStatus = 'error' | 'loading' | 'ready' | 'refreshing';

export interface ComputeSourceState<Result> {
  error: string;
  result?: Result;
  status: ComputeSourceStatus;
}

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

  const refreshTailscale = useCallback(async (forceRefresh = true) => {
    setTailscale((current) => ({
      ...current,
      error: '',
      status: current.result ? 'refreshing' : 'loading'
    }));
    try {
      const result = await projectSpaceClient.getTailscaleInventory(forceRefresh);
      setTailscale({ error: '', result, status: 'ready' });
      return result;
    } catch {
      setTailscale((current) => ({
        ...current,
        error: 'Tailscale inventory could not be refreshed.',
        status: 'error'
      }));
      return undefined;
    }
  }, []);

  const refreshGitHub = useCallback(async () => {
    setGitHub((current) => ({
      ...current,
      error: '',
      status: current.result ? 'refreshing' : 'loading'
    }));
    try {
      const result = await projectSpaceClient.getGitHubCodespaceInventory();
      setGitHub({ error: '', result, status: 'ready' });
      return result;
    } catch {
      setGitHub((current) => ({
        ...current,
        error: 'GitHub Codespaces could not be refreshed.',
        status: 'error'
      }));
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
