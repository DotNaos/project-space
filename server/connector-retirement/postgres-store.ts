import type { DatabaseQueryClient } from '../database/client';
import {
  type ConnectorCompatibilitySurface,
  type ConnectorCompatibilityUsageStore
} from './contracts';

interface SnapshotRow {
  catalog_version: string | null;
  continuous_since: Date | null;
  first_successful_use_at: Date | null;
  last_successful_use_at: Date | null;
  observed_at: Date | null;
  successful_use_count: string | number | null;
  surface: ConnectorCompatibilitySurface | null;
}

interface OwnerRow { owner_user_id: string }

export class PostgresConnectorCompatibilityUsageStore
implements ConnectorCompatibilityUsageStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async beginRecorderSession(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    startedAt: string,
    maximumGapSeconds: number
  ) {
    const result = await this.client.query<{ owner_user_id: string }>(
      `insert into connector_compatibility_observations (
         owner_user_id, catalog_version, continuous_since, observed_at,
         recorder_session_id, recorder_state
       ) values ($1, $2, $3::timestamptz, $3::timestamptz, $4, 'active')
       on conflict (owner_user_id) do update set
         catalog_version = excluded.catalog_version,
         continuous_since = case
           when connector_compatibility_observations.recorder_state = 'clean'
            and connector_compatibility_observations.catalog_version = excluded.catalog_version
            and excluded.observed_at >= connector_compatibility_observations.observed_at
            and excluded.observed_at - connector_compatibility_observations.observed_at
                <= $5::integer * interval '1 second'
             then connector_compatibility_observations.continuous_since
           else excluded.observed_at
         end,
         observed_at = greatest(
           connector_compatibility_observations.observed_at,
           excluded.observed_at
         ),
         recorder_session_id = excluded.recorder_session_id,
         recorder_state = 'active'
       returning owner_user_id`,
      [ownerUserId, catalogVersion, startedAt, sessionId, maximumGapSeconds]
    );
    if (result.rows.length !== 1) {
      throw new Error('Connector retirement recorder session could not start.');
    }
  }

  async checkpoint(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    observedAt: string,
    maximumGapSeconds: number,
    resetContinuity = false
  ) {
    const result = await this.client.query<{ owner_user_id: string }>(
      `update connector_compatibility_observations set
         catalog_version = $3,
         continuous_since = case
           when not $6::boolean
            and connector_compatibility_observations.catalog_version = $3
            and $4::timestamptz >= connector_compatibility_observations.observed_at
            and $4::timestamptz - connector_compatibility_observations.observed_at
                <= $5::integer * interval '1 second'
             then connector_compatibility_observations.continuous_since
           else $4::timestamptz
         end,
         observed_at = greatest(observed_at, $4::timestamptz)
       where owner_user_id = $1 and recorder_session_id = $2 and recorder_state = 'active'
       returning owner_user_id`,
      [
        ownerUserId,
        sessionId,
        catalogVersion,
        observedAt,
        maximumGapSeconds,
        resetContinuity
      ]
    );
    if (result.rows.length !== 1) {
      throw new Error('Connector retirement recorder session changed.');
    }
  }

  async list(ownerUserId: string) {
    const result = await this.client.query<SnapshotRow>(
      `select o.catalog_version, o.continuous_since, o.observed_at,
              u.surface, u.successful_use_count,
              u.first_successful_use_at, u.last_successful_use_at
         from connector_compatibility_observations o
         full outer join connector_compatibility_usage u
           on u.owner_user_id = o.owner_user_id
        where coalesce(o.owner_user_id, u.owner_user_id) = $1
        order by u.surface nulls first`,
      [ownerUserId]
    );
    const checkpoint = result.rows.find((row) =>
      row.catalog_version && row.continuous_since && row.observed_at
    );
    return {
      ...(checkpoint ? { observation: {
        catalogVersion: checkpoint.catalog_version!,
        continuousSince: checkpoint.continuous_since!.toISOString(),
        observedAt: checkpoint.observed_at!.toISOString()
      } } : {}),
      usage: result.rows.filter((row) =>
        row.surface && row.first_successful_use_at && row.last_successful_use_at &&
        row.successful_use_count !== null
      ).map((row) => ({
        firstSuccessfulUseAt: row.first_successful_use_at!.toISOString(),
        lastSuccessfulUseAt: row.last_successful_use_at!.toISOString(),
        successfulUseCount: Number(row.successful_use_count),
        surface: row.surface!
      }))
    };
  }

  async listObservedOwners() {
    const result = await this.client.query<OwnerRow>(
      `select owner_user_id from connector_compatibility_observations order by owner_user_id`
    );
    return result.rows.map(({ owner_user_id }) => owner_user_id);
  }

  async recordSuccess(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    surface: ConnectorCompatibilitySurface,
    completedAt: string,
    maximumGapSeconds: number
  ) {
    const result = await this.client.query<{ accepted: number }>(
      `with recorder as (
         update connector_compatibility_observations set
           catalog_version = $5,
           continuous_since = case
             when catalog_version = $5
              and $4::timestamptz >= observed_at
              and $4::timestamptz - observed_at <= $6::integer * interval '1 second'
               then continuous_since
             else $4::timestamptz
           end,
           observed_at = greatest(observed_at, $4::timestamptz)
         where owner_user_id = $1 and recorder_session_id = $2 and recorder_state = 'active'
         returning 1
       ), usage as (
         insert into connector_compatibility_usage (
           owner_user_id, surface, successful_use_count,
           first_successful_use_at, last_successful_use_at
         ) select $1, $3, 1, $4::timestamptz, $4::timestamptz from recorder
         on conflict (owner_user_id, surface) do update set
           successful_use_count = connector_compatibility_usage.successful_use_count + 1,
           first_successful_use_at = least(
             connector_compatibility_usage.first_successful_use_at,
             excluded.first_successful_use_at
           ),
           last_successful_use_at = greatest(
             connector_compatibility_usage.last_successful_use_at,
             excluded.last_successful_use_at
         )
         returning 1
       )
       select count(*)::integer as accepted from usage`,
      [
        ownerUserId,
        sessionId,
        surface,
        completedAt,
        catalogVersion,
        maximumGapSeconds
      ]
    );
    if (result.rows[0]?.accepted !== 1) {
      throw new Error('Connector retirement recorder session changed.');
    }
  }

  async closeRecorderSession(sessionId: string, closedAt: string) {
    await this.client.query(
      `update connector_compatibility_observations set
         recorder_state = 'clean',
         observed_at = greatest(observed_at, $2::timestamptz)
       where recorder_session_id = $1 and recorder_state = 'active'`,
      [sessionId, closedAt]
    );
  }
}
