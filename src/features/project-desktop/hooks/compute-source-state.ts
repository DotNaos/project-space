import type { ComputeSourceStatus, ComputeSourceState } from './use-compute-sources-types';
import type {
  TailscaleDeviceClassification,
  TailscaleInventoryDevice,
  TailscaleInventoryResult
} from '@/shared/tailscale-inventory-api';

export function createComputeSourceRequestGate() {
  let latestRequest = 0;
  return {
    begin() {
      latestRequest += 1;
      return latestRequest;
    },
    isLatest(request: number) {
      return request === latestRequest;
    }
  };
}

export function computeSourceLoadingState<Result>(current: ComputeSourceState<Result>): ComputeSourceState<Result> {
  return { ...current, error: '', status: current.result ? 'refreshing' : 'loading' };
}

export function computeSourceReadyState<Result>(result: Result): ComputeSourceState<Result> {
  return { error: '', result, status: 'ready' };
}

export function computeSourceErrorState<Result>(current: ComputeSourceState<Result>, error: string): ComputeSourceState<Result> {
  return { ...current, error, status: 'error' };
}

export function computeTailscaleSourceErrorState(
  current: ComputeSourceState<TailscaleInventoryResult>,
  error: string
): ComputeSourceState<TailscaleInventoryResult> {
  if (!current.result) return { ...current, error, status: 'error' };
  return {
    error,
    status: 'error',
    result: {
      ...current.result,
      devices: current.result.devices.map((device) => ({
        ...device,
        network: { ...device.network, state: 'unknown' }
      })),
      provider: { ...current.result.provider, refreshState: 'unavailable' }
    }
  };
}

export function mergeTailscaleRefreshResult(
  current: TailscaleInventoryResult | undefined,
  incoming: TailscaleInventoryResult
): TailscaleInventoryResult {
  if (!current) return incoming;
  const currentById = new Map(current.devices.map((device) => [device.id, device]));
  return {
    ...incoming,
    devices: incoming.devices.map((device) => {
      const local = currentById.get(device.id);
      return local && local.revision > device.revision
        ? { ...device, classification: local.classification, revision: local.revision }
        : device;
    })
  };
}

export function applyTailscaleClassificationResult(
  current: TailscaleInventoryResult | undefined,
  saved: Pick<TailscaleInventoryDevice, 'id' | 'classification' | 'revision'>
): TailscaleInventoryResult | undefined {
  if (!current) return current;
  return {
    ...current,
    devices: current.devices.map((device) => device.id !== saved.id || device.revision > saved.revision
      ? device
      : {
          ...device,
          classification: saved.classification as TailscaleDeviceClassification,
          revision: saved.revision
        })
  };
}
