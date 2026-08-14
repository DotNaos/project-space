import type {
  TailscaleClassificationRequest,
  TailscaleInventoryResult,
  TailscaleProviderNetworkState
} from '../../src/shared/tailscale-inventory-api';
import {
  tailscaleInventoryApiVersion,
  type TailscaleDeviceClassification
} from '../../src/shared/tailscale-inventory-api';
import type { TailscaleInventorySource } from './source';
import type { StoredTailscaleDevice, TailscaleInventoryReconciliation } from './store';
import {
  TailscaleClassificationRevisionConflict,
  UnknownTailscaleDevice
} from './store';

export class TailscaleInventoryServiceError extends Error {
  constructor(readonly code: 'machine-forbidden' | 'unknown-device', message: string) {
    super(message);
    this.name = 'TailscaleInventoryServiceError';
  }
}

export interface TailscaleInventoryStore {
  list(ownerUserId: string): Promise<StoredTailscaleDevice[]>;
  reconcile(ownerUserId: string, input: TailscaleInventoryReconciliation): Promise<unknown>;
  setClassification(input: {
    actorId: string; classification: TailscaleDeviceClassification; deviceId: string;
    expectedRevision: number; ownerUserId: string;
  }): Promise<{ classification: TailscaleDeviceClassification; id: string; revision: number }>;
}

export function createTailscaleInventoryService(options: {
  clock?: () => number;
  minimumRefreshIntervalMs?: number;
  now?: () => Date;
  source: TailscaleInventorySource;
  store: TailscaleInventoryStore;
}) {
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => Date.now());
  const minimumRefreshIntervalMs = options.minimumRefreshIntervalMs ?? 2_000;
  let refreshInFlight: ReturnType<TailscaleInventorySource['observe']> | undefined;
  let cachedRefresh: {
    completedAt: number;
    result: Awaited<ReturnType<TailscaleInventorySource['observe']>>;
  } | undefined;

  const observe = async () => {
    const currentTime = clock();
    if (cachedRefresh && currentTime - cachedRefresh.completedAt < minimumRefreshIntervalMs) {
      return cachedRefresh.result;
    }
    const current = refreshInFlight ?? options.source.observe();
    refreshInFlight = current;
    try {
      const result = await current;
      cachedRefresh = { completedAt: clock(), result };
      return result;
    } finally {
      if (refreshInFlight === current) refreshInFlight = undefined;
    }
  };

  return {
    async list(ownerUserId: string, refresh = false): Promise<TailscaleInventoryResult> {
      let refreshState: TailscaleInventoryResult['provider']['refreshState'] = 'not_checked';
      let reasonCode: string | undefined;
      let errorCount: number | undefined;
      if (refresh) {
        const observed = await observe();
        if (observed.available) {
          await options.store.reconcile(ownerUserId, {
            complete: true, kind: 'snapshot', snapshot: observed.snapshot
          });
          if (observed.snapshot.deviceErrors.length > 0) {
            refreshState = 'partial'; errorCount = observed.snapshot.deviceErrors.length;
          } else {
            refreshState = 'available';
          }
        } else {
          refreshState = 'unavailable'; reasonCode = observed.error.code;
          await options.store.reconcile(ownerUserId, {
            kind: 'provider-failure', observedAt: now().toISOString()
          });
        }
      }
      return {
        devices: (await options.store.list(ownerUserId)).map((device) =>
          toPublicDevice(device, refreshState === 'unavailable')
        ),
        provider: {
          ...(errorCount === undefined ? {} : { errorCount }),
          ...(reasonCode ? { reasonCode } : {}), refreshState
        },
        schemaVersion: tailscaleInventoryApiVersion
      };
    },
    async setClassification(
      actor: { actorId: string; kind: 'human' | 'machine'; ownerUserId: string },
      deviceId: string,
      request: TailscaleClassificationRequest
    ) {
      if (actor.kind !== 'human') {
        throw new TailscaleInventoryServiceError('machine-forbidden', 'Only a person may classify Tailscale devices.');
      }
      try {
        return await options.store.setClassification({
          actorId: actor.actorId, classification: request.classification, deviceId,
          expectedRevision: request.expectedRevision, ownerUserId: actor.ownerUserId
        });
      } catch (error) {
        if (error instanceof UnknownTailscaleDevice) {
          throw new TailscaleInventoryServiceError('unknown-device', 'Tailscale device was not found.');
        }
        throw error;
      }
    }
  };
}

function toPublicDevice(device: StoredTailscaleDevice, providerUnavailable: boolean) {
  const freshness = device.freshness;
  const state: TailscaleProviderNetworkState = providerUnavailable ? 'unknown'
    : freshness.state === 'stale'
    ? 'stale'
    : freshness.state !== 'fresh'
      ? 'unknown'
      : device.online ? 'online' : 'offline';
  return {
    addresses: [...device.addresses], classification: device.classification, id: device.id,
    ...(device.observedName ? { name: device.observedName } : {}),
    network: {
      checkedAt: freshness.observedAt, freshUntil: freshness.freshUntil,
      ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}), state
    },
    ...(device.os ? { os: device.os } : {}), revision: device.revision, tags: [...device.tags]
  };
}

export { TailscaleClassificationRevisionConflict };
