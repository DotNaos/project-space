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
  constructor(
    readonly code: 'connection-unavailable' | 'machine-forbidden' | 'unknown-device',
    message: string
  ) {
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
  const refreshInFlight = new Map<string, ReturnType<TailscaleInventorySource['observe']>>();
  const cachedRefresh = new Map<string, {
    completedAt: number;
    result: Awaited<ReturnType<TailscaleInventorySource['observe']>>;
  }>();

  const observe = async (ownerUserId: string, cacheKey: string) => {
    const currentTime = clock();
    const cached = cachedRefresh.get(cacheKey);
    if (cached && currentTime - cached.completedAt < minimumRefreshIntervalMs) {
      return cached.result;
    }
    const current = refreshInFlight.get(cacheKey) ?? options.source.observe(ownerUserId);
    refreshInFlight.set(cacheKey, current);
    try {
      const result = await current;
      cachedRefresh.set(cacheKey, { completedAt: clock(), result });
      return result;
    } finally {
      if (refreshInFlight.get(cacheKey) === current) refreshInFlight.delete(cacheKey);
    }
  };

  return {
    async list(ownerUserId: string, refresh = false): Promise<TailscaleInventoryResult> {
      let descriptor = await options.source.describe?.(ownerUserId) ?? {
        connectionState: 'not_connected' as const,
        source: 'not_connected' as const
      };
      let refreshState: TailscaleInventoryResult['provider']['refreshState'] = 'not_checked';
      let reasonCode: string | undefined;
      let errorCount: number | undefined;
      if (refresh) {
        const cacheKey = [ownerUserId, descriptor.source, descriptor.connectionId ?? '',
          descriptor.revision ?? 0].join('\u0000');
        const observed = await observe(ownerUserId, cacheKey);
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
          if (observed.error.code === 'connection_missing' ||
            observed.error.code === 'credentials_invalid' ||
            observed.error.code === 'scope_insufficient') {
            descriptor = { ...descriptor, connectionState: 'reauthorization_required' };
          }
          await options.store.reconcile(ownerUserId, {
            kind: 'provider-failure', observedAt: now().toISOString()
          });
        }
      }
      return {
        devices: (await options.store.list(ownerUserId)).map((device) =>
          toPublicDevice(device, refreshState === 'unavailable' ||
            !['connected', 'legacy'].includes(descriptor.connectionState))
        ),
        provider: {
          ...(descriptor.connectionId ? { connectionId: descriptor.connectionId } : {}),
          connectionState: descriptor.connectionState,
          ...(errorCount === undefined ? {} : { errorCount }),
          ...(reasonCode ? { reasonCode } : {}), refreshState,
          source: descriptor.source
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
      const descriptor = await options.source.describe?.(actor.ownerUserId);
      if (descriptor && !['connected', 'legacy'].includes(descriptor.connectionState)) {
        throw new TailscaleInventoryServiceError(
          'connection-unavailable',
          'A Tailscale provider connection is required before devices can be classified.'
        );
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
