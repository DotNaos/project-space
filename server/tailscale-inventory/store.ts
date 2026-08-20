import type { DatabaseQueryClient } from '../database/client';
import { isTailscaleAddress } from './status-decoder';
import {
  tailscaleDeviceClassifications,
  type TailscaleDeviceClassification,
  type TailscaleDeviceObservation,
  type TailscaleStatusSnapshot
} from './contracts';
import {
  projectTailscaleClassification,
  refreshTailscaleEnvironmentProjection,
  TailscaleEnvironmentInUse as ProjectionEnvironmentInUse
} from './compute-environment-projection';
import {
  lockTailscaleEnvironmentOwnershipReconciliation,
  reconcileTailscaleEnvironmentOwnership,
  tailscaleDeploymentOwner
} from '../database/tailscale-environment-ownership-reconciler';

export type TailscaleInventoryReconciliation =
  | { complete: boolean; kind: 'snapshot'; snapshot: TailscaleStatusSnapshot }
  | { kind: 'provider-failure'; observedAt: string };

export interface StoredTailscaleDevice extends TailscaleDeviceObservation {
  classification: TailscaleDeviceClassification;
  freshness: TailscaleStatusSnapshot['freshness'];
  revision: number;
  staleAt?: string;
  state: 'current' | 'stale';
}

interface DeviceRow {
  addresses: unknown; classification: string | null; device_id: string;
  fresh_until: Date | string; inventory_state: 'current' | 'stale';
  last_seen_at: Date | string | null; observed_at: Date | string;
  observed_name: string | null; online: boolean; os: string | null;
  revision: number | string | null; stale_at: Date | string | null; tags: unknown;
}

interface ClassificationRow { classification: string; revision: number | string; }

export class TailscaleClassificationRevisionConflict extends Error {
  constructor(readonly current: Pick<StoredTailscaleDevice, 'classification' | 'id' | 'revision'>) {
    super('The Tailscale device classification changed before this update was saved.');
    this.name = 'TailscaleClassificationRevisionConflict';
  }
}

export class UnknownTailscaleDevice extends Error {
  constructor() {
    super('No observed Tailscale device exists for this classification change.');
    this.name = 'UnknownTailscaleDevice';
  }
}

/** A 409-safe classification conflict: derived Environment rows are still in use. */
export class TailscaleEnvironmentInUse extends TailscaleClassificationRevisionConflict {
  constructor(current: Pick<StoredTailscaleDevice, 'classification' | 'id' | 'revision'>) {
    super(current);
    this.message = 'The Tailscale Environment still has Project Space references.';
    this.name = 'TailscaleEnvironmentInUse';
  }
}

export class PostgresTailscaleInventoryStore {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  async reconcile(ownerUserId: string, reconciliation: TailscaleInventoryReconciliation) {
    requireIdentifier(ownerUserId, 'owner user id');
    if (reconciliation.kind === 'provider-failure') {
      return { kind: 'provider-failure' as const, observedAt: isoDate(reconciliation.observedAt) };
    }
    const { snapshot } = reconciliation;
    const observedAt = isoDate(snapshot.freshness.observedAt);
    const freshUntil = isoDate(snapshot.freshness.freshUntil);
    if (freshUntil <= observedAt) throw new Error('Tailscale snapshot freshness is invalid.');
    const devices = snapshot.devices.map(normalizeObservation);
    const ids = new Set<string>();
    for (const device of devices) {
      if (ids.has(device.id)) throw new Error('A Tailscale snapshot contains a duplicate device id.');
      ids.add(device.id);
    }
    const complete = reconciliation.complete && snapshot.deviceErrors.length === 0;
    const run = async (client: DatabaseQueryClient) => {
      const reconcileOwnership = ownerUserId === tailscaleDeploymentOwner;
      if (reconcileOwnership) {
        await lockTailscaleEnvironmentOwnershipReconciliation(client);
      }
      for (const device of devices) {
        await client.query(
          `insert into tailscale_device_observations (
             owner_user_id, device_id, observed_name, addresses, online, os, tags, observed_at,
             fresh_until, last_seen_at, inventory_state, stale_at, updated_at
           ) values ($1, $2, $3, $4::inet[], $5, $6, $7::text[], $8::timestamptz,
                     $9::timestamptz, $10::timestamptz, 'current', null, now())
           on conflict (owner_user_id, device_id) do update set
             observed_name = excluded.observed_name, addresses = excluded.addresses,
             online = excluded.online, os = excluded.os, tags = excluded.tags,
             observed_at = excluded.observed_at, fresh_until = excluded.fresh_until,
             last_seen_at = excluded.last_seen_at, inventory_state = 'current', stale_at = null,
             updated_at = now()
           where excluded.observed_at > tailscale_device_observations.observed_at`,
          [ownerUserId, device.id, device.observedName ?? null, device.addresses, device.online,
            device.os ?? null, device.tags, observedAt, freshUntil, device.lastSeenAt ?? null]
        );
        await refreshTailscaleEnvironmentProjection(client, ownerUserId, device.id);
      }
      if (complete) {
        await client.query(
          `update tailscale_device_observations
              set inventory_state = 'stale', stale_at = $2::timestamptz, updated_at = now()
            where owner_user_id = $1 and inventory_state = 'current'
              and observed_at < $2::timestamptz
              and not (device_id = any($3::text[]))`,
          [ownerUserId, observedAt, devices.map(({ id }) => id)]
        );
      }
      if (reconcileOwnership) await reconcileTailscaleEnvironmentOwnership(client);
    };
    await this.transaction(run);
    return { complete, kind: 'reconciled' as const, observedAt, observedDeviceCount: devices.length };
  }

  async list(ownerUserId: string): Promise<StoredTailscaleDevice[]> {
    requireIdentifier(ownerUserId, 'owner user id');
    const result = await this.client.query<DeviceRow>(
      `select observations.device_id, observations.observed_name,
              array(
                select host(address)
                  from unnest(observations.addresses) address
                 order by host(address)
              ) as addresses,
              observations.online, observations.os, observations.tags, observations.observed_at,
              observations.fresh_until, observations.last_seen_at, observations.inventory_state,
              observations.stale_at, classifications.classification, classifications.revision
         from tailscale_device_observations observations
         left join tailscale_device_classifications classifications
           on classifications.owner_user_id = observations.owner_user_id
          and classifications.device_id = observations.device_id
        where observations.owner_user_id = $1 order by observations.device_id`,
      [ownerUserId]
    );
    const now = this.now();
    return result.rows
      .map((row) => mapDeviceRow(row, now))
      .filter((device): device is StoredTailscaleDevice => !!device);
  }

  async setClassification(input: {
    actorId: string; classification: TailscaleDeviceClassification; deviceId: string;
    expectedRevision: number; ownerUserId: string;
  }): Promise<Pick<StoredTailscaleDevice, 'classification' | 'id' | 'revision'>> {
    requireIdentifier(input.ownerUserId, 'owner user id');
    requireIdentifier(input.actorId, 'actor id');
    requireIdentifier(input.deviceId, 'device id');
    if (!validClassification(input.classification)) throw new Error('A Tailscale device classification is invalid.');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('The expected Tailscale classification revision is invalid.');
    }
    const run = async (client: DatabaseQueryClient) => {
      const reconcileOwnership = input.ownerUserId === tailscaleDeploymentOwner;
      if (reconcileOwnership) {
        await lockTailscaleEnvironmentOwnershipReconciliation(client);
      }
      const observed = await client.query<{ device_id: string }>(
        `select device_id from tailscale_device_observations
          where owner_user_id = $1 and device_id = $2 for update`,
        [input.ownerUserId, input.deviceId]
      );
      if (!observed.rows[0]) throw new UnknownTailscaleDevice();
      const current = (await client.query<ClassificationRow>(
        `select classification, revision from tailscale_device_classifications
          where owner_user_id = $1 and device_id = $2 for update`,
        [input.ownerUserId, input.deviceId]
      )).rows[0];
      const classification = validClassification(current?.classification)
        ? current.classification : 'unclassified';
      const revision = Number(current?.revision ?? 0);
      const record = { classification, id: input.deviceId, revision };
      if (revision !== input.expectedRevision) throw new TailscaleClassificationRevisionConflict(record);
      const saved = await client.query<ClassificationRow>(
        `insert into tailscale_device_classifications (
           owner_user_id, device_id, classification, revision, actor_id, updated_at
         ) values ($1, $2, $3, 1, $4, now())
         on conflict (owner_user_id, device_id) do update set
           classification = excluded.classification,
           revision = tailscale_device_classifications.revision + 1,
           actor_id = excluded.actor_id, updated_at = now()
         where tailscale_device_classifications.revision = $5
         returning classification, revision`,
        [input.ownerUserId, input.deviceId, input.classification, input.actorId, input.expectedRevision]
      );
      const next = saved.rows[0];
      if (!next || !validClassification(next.classification)) {
        throw new TailscaleClassificationRevisionConflict(record);
      }
      const nextRevision = Number(next.revision);
      try {
        await projectTailscaleClassification(client, {
          classification: next.classification,
          deviceId: input.deviceId,
          ownerUserId: input.ownerUserId,
          revision: nextRevision
        });
      } catch (error) {
        if (error instanceof ProjectionEnvironmentInUse) throw new TailscaleEnvironmentInUse(record);
        throw error;
      }
      await client.query(
        `insert into tailscale_device_classification_audits (
           owner_user_id, device_id, actor_id, previous_classification, next_classification, revision
         ) values ($1, $2, $3, $4, $5, $6)`,
        [input.ownerUserId, input.deviceId, input.actorId, classification, next.classification, nextRevision]
      );
      if (reconcileOwnership) await reconcileTailscaleEnvironmentOwnership(client);
      return { classification: next.classification, id: input.deviceId, revision: nextRevision };
    };
    return this.transaction(run);
  }

  private transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    if (!this.client.transaction) {
      throw new Error('The Tailscale inventory store requires transactional database access.');
    }
    return this.client.transaction(operation);
  }
}

function normalizeObservation(input: TailscaleDeviceObservation): TailscaleDeviceObservation {
  requireIdentifier(input.id, 'device id');
  const observedName = input.observedName?.trim();
  if (observedName && (observedName.length > 128 || hasControlCharacter(observedName))) {
    throw new Error('A Tailscale device name is invalid.');
  }
  const addresses = [...new Set(input.addresses.map((address) => address.trim()))].sort();
  if (addresses.length === 0 || addresses.length > 32 ||
    addresses.some((address) => !isTailscaleAddress(address))) {
    throw new Error('A Tailscale device address must be an exact numeric Tailscale IP address.');
  }
  const tags = [...new Set(input.tags.map((tag) => tag.trim()))].sort();
  if (tags.length > 64 || tags.some((tag) => !tag || tag.length > 256 || hasControlCharacter(tag))) {
    throw new Error('A Tailscale device tag is invalid.');
  }
  if (input.os && (input.os.length > 128 || hasControlCharacter(input.os))) {
    throw new Error('A Tailscale device operating system is invalid.');
  }
  return { ...input, addresses, ...(input.lastSeenAt ? { lastSeenAt: isoDate(input.lastSeenAt) } : {}),
    ...(observedName ? { observedName } : {}), tags };
}

function requireIdentifier(value: string, label: string) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`The ${label} is invalid.`);
}
function isoDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('The Tailscale observation time is invalid.');
  return date.toISOString();
}
function hasControlCharacter(value: string) { return /[\u0000-\u001f\u007f]/.test(value); }
function validClassification(value: unknown): value is TailscaleDeviceClassification {
  return typeof value === 'string' && tailscaleDeviceClassifications.includes(value as TailscaleDeviceClassification);
}
function mapDeviceRow(row: DeviceRow, now: Date): StoredTailscaleDevice | undefined {
  const classification = row.classification ?? 'unclassified';
  if (!validClassification(classification) || !Array.isArray(row.addresses) ||
    row.addresses.some((address) => typeof address !== 'string') || !Array.isArray(row.tags) ||
    row.tags.some((tag) => typeof tag !== 'string')) return undefined;
  const revision = Number(row.revision ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) return undefined;
  const observedAt = isoDate(row.observed_at);
  const freshUntil = isoDate(row.fresh_until);
  if (freshUntil <= observedAt) return undefined;
  const staleAt = row.stale_at ? isoDate(row.stale_at) : undefined;
  const freshnessState = row.inventory_state === 'stale' || now.getTime() >= Date.parse(freshUntil)
    ? 'stale' as const
    : 'fresh' as const;
  try {
    const observation = normalizeObservation({
      addresses: row.addresses,
      id: row.device_id,
      ...(row.last_seen_at ? { lastSeenAt: isoDate(row.last_seen_at) } : {}),
      ...(row.observed_name ? { observedName: row.observed_name } : {}),
      online: row.online,
      ...(row.os ? { os: row.os } : {}),
      tags: row.tags
    });
    return {
      ...observation,
      classification,
      freshness: { observedAt, freshUntil, state: freshnessState },
      revision,
      ...(staleAt ? { staleAt } : {}),
      state: row.inventory_state
    };
  } catch {
    return undefined;
  }
}
