import type { TailscaleInventoryResult } from '@/shared/tailscale-inventory-api';

export function isTailscaleClassificationControlDisabled(
  classificationDisabled: boolean,
  pending: boolean
) {
  return classificationDisabled || pending;
}

export function canClearTailscaleRowError(
  result: TailscaleInventoryResult | undefined,
  deviceId: string,
  revision: number
) {
  if (!result || !['available', 'partial'].includes(result.provider.refreshState)) return false;
  const device = result.devices.find((entry) => entry.id === deviceId);
  return Boolean(device && device.revision >= revision);
}

export function shouldClearTailscaleRowErrorOnRevision(
  previousRevision: number,
  currentRevision: number,
  providerRefreshIsProven: boolean,
  providerRefreshGeneration = 1,
  failedSaveRefreshGeneration = 0
) {
  return providerRefreshIsProven &&
    providerRefreshGeneration > failedSaveRefreshGeneration &&
    currentRevision >= previousRevision;
}

export function createTailscaleRowErrorRefreshState() {
  let latestRefreshGeneration = 0;
  let failedSaveRefreshGeneration: number | null = null;

  return {
    observeRefreshGeneration(generation: number) {
      latestRefreshGeneration = generation;
    },
    recordFailedSave() {
      failedSaveRefreshGeneration = latestRefreshGeneration;
    },
    clearAfterReload() {
      failedSaveRefreshGeneration = null;
    },
    shouldClear(previousRevision: number, currentRevision: number, providerRefreshIsProven: boolean) {
      return shouldClearTailscaleRowErrorOnRevision(
        previousRevision,
        currentRevision,
        providerRefreshIsProven,
        latestRefreshGeneration,
        failedSaveRefreshGeneration ?? -1
      );
    }
  };
}
