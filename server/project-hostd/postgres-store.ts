import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { DatabaseQueryClient } from '../database/client';
import {
  projectHostdSchemaVersion,
  type ProjectHostdCredential,
  type ProjectHostdObservation,
  type ProjectHostdSnapshot
} from '../../src/shared/project-hostd-api';
import type {
  IssueProjectHostdCredentialInput,
  ProjectHostdCredentialScope,
  ProjectHostdStore
} from './contracts';
import { ProjectHostdError } from './contracts';
import { validateCredentialIssue } from './validation';

interface DeviceRow {
  connection_state: ProjectHostdSnapshot['connectionState'];
  credential_id: string;
  device_id: string;
  environment_id: string;
  expires_at: Date | string;
  health: ProjectHostdSnapshot['health'] | null;
  host_id: string | null;
  hostd_version: string | null;
  last_seen_at: Date | string | null;
  last_sequence: number | string;
  observed_at: Date | string | null;
  owner_user_id: string;
  partial_metrics: ProjectHostdSnapshot['partialMetrics'];
  protocol_version: number | null;
  resources: ProjectHostdSnapshot['resources'] | null;
  revoked_at: Date | string | null;
  runtimes: ProjectHostdSnapshot['runtimes'];
  uptime_seconds: number | string | null;
}

interface IssuedOperationRow {
  device_id: string;
  environment_id: string;
  host_id: string | null;
}

interface ObservationRow {
  fingerprint_sha256: string;
  observation_id: string;
  sequence: number | string;
}

export class PostgresProjectHostdStore implements ProjectHostdStore {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly createCredentialId = randomUUID,
    private readonly createToken = () => randomBytes(32).toString('base64url')
  ) {
    if (!client.transaction) throw new Error('project-hostd store requires transactions.');
  }

  async issue(input: IssueProjectHostdCredentialInput) {
    const token = this.createToken();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').byteLength !== 32) {
      throw new Error('project-hostd credential must contain 32 random bytes.');
    }
    const credentialId = this.createCredentialId();
    const expiresInSeconds = validateCredentialIssue(input);
    return this.transaction(async (client) => {
      await lock(client, `project-hostd-operation:${input.ownerUserId}:${input.operationId}`);
      await lock(client, `project-hostd-device:${input.ownerUserId}:${input.deviceId}`);
      await requireCurrentTarget(client, input);
      const operation = await client.query<IssuedOperationRow>(
        `select c.device_id::text, d.environment_id::text, d.host_id::text
           from project_hostd_credentials c join project_hostd_devices d
             on d.owner_user_id = c.owner_user_id and d.device_id = c.device_id
          where c.owner_user_id = $1 and c.operation_id = $2 for update`,
        [input.ownerUserId, input.operationId]
      );
      if (operation.rows[0]) {
        if (!sameIssueRow(operation.rows[0], input)) {
          throw new ProjectHostdError('replay_conflict', 'project-hostd credential request changed.');
        }
        throw new ProjectHostdError('operation_in_progress', 'project-hostd credential was already issued.');
      }
      const existing = await client.query<{ environment_id: string; host_id: string | null }>(
        `select environment_id::text, host_id::text from project_hostd_devices
          where owner_user_id = $1 and device_id = $2::uuid for update`,
        [input.ownerUserId, input.deviceId]
      );
      if (existing.rows[0] &&
        (existing.rows[0].environment_id !== input.environmentId ||
          existing.rows[0].host_id !== (input.hostId ?? null))) {
        throw new ProjectHostdError('target_conflict', 'project-hostd device target cannot change.');
      }
      await client.query(
        `insert into project_hostd_devices (
           owner_user_id, device_id, environment_id, host_id
         ) values ($1, $2::uuid, $3::uuid, $4::uuid)
         on conflict (owner_user_id, device_id) do nothing`,
        [input.ownerUserId, input.deviceId, input.environmentId, input.hostId ?? null]
      );
      await client.query(
        `update project_hostd_credentials
            set revoked_at = coalesce(revoked_at, now())
          where owner_user_id = $1 and device_id = $2::uuid and revoked_at is null`,
        [input.ownerUserId, input.deviceId]
      );
      const inserted = await client.query<{ expires_at: Date | string }>(
        `insert into project_hostd_credentials (
           owner_user_id, device_id, credential_id, operation_id, token_hash, expires_at
         ) values (
           $1, $2::uuid, $3::uuid, $4, $5, now() + ($6 * interval '1 second')
         ) returning expires_at`,
        [input.ownerUserId, input.deviceId, credentialId, input.operationId,
          hash(token), expiresInSeconds]
      );
      await client.query(
        `update project_hostd_devices set current_credential_id = $3::uuid, updated_at = now()
          where owner_user_id = $1 and device_id = $2::uuid`,
        [input.ownerUserId, input.deviceId, credentialId]
      );
      return publicCredential(input, credentialId, iso(inserted.rows[0]!.expires_at), token);
    });
  }

  async authenticate(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await this.client.query<DeviceRow>(
      `${selectDevice}
        where c.token_hash = $1 and c.revoked_at is null and c.expires_at > now() and
              d.current_credential_id = c.credential_id`,
      [hash(token)]
    );
    const row = result.rows[0];
    if (!row) return null;
    await this.client.query(
      `update project_hostd_credentials set last_authenticated_at = now()
        where owner_user_id = $1 and credential_id = $2::uuid and revoked_at is null`,
      [row.owner_user_id, row.credential_id]
    );
    return scope(row);
  }

  append(
    runtimeScope: ProjectHostdCredentialScope,
    observation: ProjectHostdObservation,
    receivedAt: string
  ) {
    return this.transaction(async (client) => {
      await lock(client, `project-hostd-device:${runtimeScope.ownerUserId}:${runtimeScope.deviceId}`);
      const current = await currentForUpdate(client, runtimeScope);
      const fingerprint = hash(JSON.stringify(observation));
      const prior = await client.query<ObservationRow>(
        `select observation_id, sequence, fingerprint_sha256
           from project_hostd_observations
          where owner_user_id = $1 and device_id = $2::uuid and
                (observation_id = $3 or sequence = $4) for update`,
        [runtimeScope.ownerUserId, runtimeScope.deviceId,
          observation.observationId, observation.sequence]
      );
      if (prior.rows.length) {
        const exact = prior.rows.length === 1 &&
          prior.rows[0]!.observation_id === observation.observationId &&
          Number(prior.rows[0]!.sequence) === observation.sequence &&
          prior.rows[0]!.fingerprint_sha256 === fingerprint;
        if (!exact) throw new ProjectHostdError('replay_conflict', 'project-hostd observation replay changed.');
        return { replayed: true, snapshot: snapshot(current) };
      }
      if (observation.sequence !== Number(current.last_sequence) + 1) {
        throw new ProjectHostdError('sequence_conflict', 'project-hostd sequence is not contiguous.');
      }
      const updated = await client.query<DeviceRow>(
        `${updateDevicePrefix}
           connection_state = 'online', health = $6, hostd_version = $7,
           protocol_version = $8, last_sequence = $9, observed_at = $10::timestamptz,
           last_seen_at = $11::timestamptz, uptime_seconds = $12,
           partial_metrics = $13, resources = $14::jsonb, runtimes = $15::jsonb,
           updated_at = $11::timestamptz
         from project_hostd_credentials c
         where d.owner_user_id = $1 and d.device_id = $2::uuid and
               d.environment_id = $3::uuid and d.host_id is not distinct from $4::uuid and
               d.current_credential_id = $5::uuid and c.owner_user_id = d.owner_user_id and
               c.device_id = d.device_id and c.credential_id = d.current_credential_id
               and c.revoked_at is null and c.expires_at > now()
         returning ${returningDevice}`,
        [runtimeScope.ownerUserId, runtimeScope.deviceId, runtimeScope.environmentId,
          runtimeScope.hostId ?? null, runtimeScope.credentialId, observation.health,
          observation.hostdVersion, observation.protocolVersion, observation.sequence,
          observation.observedAt, receivedAt, observation.uptimeSeconds,
          observation.partialMetrics, JSON.stringify(observation.resources),
          JSON.stringify(observation.runtimes)]
      );
      if (!updated.rows[0]) {
        throw new ProjectHostdError('authentication_failed', 'project-hostd authority changed.');
      }
      await client.query(
        `insert into project_hostd_observations (
           owner_user_id, device_id, observation_id, sequence, fingerprint_sha256,
           safe_payload, observed_at, received_at
         ) values ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)`,
        [runtimeScope.ownerUserId, runtimeScope.deviceId, observation.observationId,
          observation.sequence, fingerprint, JSON.stringify(observation),
          observation.observedAt, receivedAt]
      );
      return { replayed: false, snapshot: snapshot(updated.rows[0]) };
    });
  }

  async list(ownerUserId: string) {
    const result = await this.client.query<DeviceRow>(
      `${selectDevice} where d.owner_user_id = $1 and d.last_seen_at is not null`,
      [ownerUserId]
    );
    return result.rows.map(snapshot);
  }

  async markStale(staleBefore: string, checkedAt: string) {
    const result = await this.client.query<DeviceRow>(
      `${updateDevicePrefix} connection_state = 'stale', updated_at = $2::timestamptz
        from project_hostd_credentials c
        where d.connection_state = 'online' and d.last_seen_at < $1::timestamptz
          and c.owner_user_id = d.owner_user_id and c.device_id = d.device_id and
              c.credential_id = d.current_credential_id
        returning ${returningDevice}`,
      [staleBefore, checkedAt]
    );
    return result.rows.map(snapshot);
  }

  async pruneExpired(retainAfter: string) {
    const result = await this.client.query(
      `delete from project_hostd_observations o using project_hostd_devices d
        where o.owner_user_id = d.owner_user_id and o.device_id = d.device_id and
              o.sequence < d.last_sequence and o.received_at < $1::timestamptz`,
      [retainAfter]
    );
    return result.rowCount ?? 0;
  }

  replay(runtimeScope: ProjectHostdCredentialScope, observation: ProjectHostdObservation) {
    return this.transaction(async (client) => {
      await lock(client, `project-hostd-device:${runtimeScope.ownerUserId}:${runtimeScope.deviceId}`);
      const current = await currentForUpdate(client, runtimeScope);
      const prior = await client.query<ObservationRow>(
        `select observation_id, sequence, fingerprint_sha256
           from project_hostd_observations
          where owner_user_id = $1 and device_id = $2::uuid and
                (observation_id = $3 or sequence = $4) for update`,
        [runtimeScope.ownerUserId, runtimeScope.deviceId,
          observation.observationId, observation.sequence]
      );
      if (!prior.rows.length) return null;
      const fingerprint = hash(JSON.stringify(observation));
      const exact = prior.rows.length === 1 &&
        prior.rows[0]!.observation_id === observation.observationId &&
        Number(prior.rows[0]!.sequence) === observation.sequence &&
        prior.rows[0]!.fingerprint_sha256 === fingerprint;
      if (!exact) {
        throw new ProjectHostdError('replay_conflict', 'project-hostd observation replay changed.');
      }
      return snapshot(current);
    });
  }

  async revoke(ownerUserId: string, deviceId: string, credentialId: string) {
    await this.client.query(
      `update project_hostd_credentials set revoked_at = coalesce(revoked_at, now())
        where owner_user_id = $1 and device_id = $2::uuid and credential_id = $3::uuid`,
      [ownerUserId, deviceId, credentialId]
    );
  }

  private transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return this.client.transaction!(operation);
  }
}

async function currentForUpdate(
  client: DatabaseQueryClient,
  scopeValue: ProjectHostdCredentialScope
) {
  await requireCurrentTarget(client, scopeValue);
  const result = await client.query<DeviceRow>(
    `${selectDevice}
      where d.owner_user_id = $1 and d.device_id = $2::uuid and
            d.environment_id = $3::uuid and d.host_id is not distinct from $4::uuid and
            d.current_credential_id = $5::uuid and c.revoked_at is null and c.expires_at > now()
      for update`,
    [scopeValue.ownerUserId, scopeValue.deviceId, scopeValue.environmentId,
      scopeValue.hostId ?? null, scopeValue.credentialId]
  );
  if (!result.rows[0]) {
    throw new ProjectHostdError('authentication_failed', 'project-hostd authority changed or expired.');
  }
  return result.rows[0];
}

async function requireCurrentTarget(
  client: DatabaseQueryClient,
  target: Pick<ProjectHostdCredentialScope, 'environmentId' | 'hostId' | 'ownerUserId'>
) {
  const result = await client.query<{ matched: boolean }>(
    `select true as matched
       from compute_environments e
       left join compute_hosts h
         on h.id = e.host_id and h.owner_user_id = e.owner_user_id
      where e.id = $1::uuid and e.owner_user_id = $2 and
            e.identity_resolution = 'resolved' and (
              ($3::uuid is null and e.host_id is null and
                e.host_resolution in ('unresolved', 'not_applicable')) or
              ($3::uuid is not null and e.host_id = $3::uuid and
                e.host_resolution in ('verified', 'manual') and
                h.identity_resolution = 'resolved')
            )
      for update of e`,
    [target.environmentId, target.ownerUserId, target.hostId ?? null]
  );
  if (!result.rows[0]) {
    throw new ProjectHostdError('target_conflict', 'project-hostd target binding changed.');
  }
}

function snapshot(row: DeviceRow): ProjectHostdSnapshot {
  if (!row.health || !row.hostd_version || row.protocol_version !== 1 ||
    !row.observed_at || !row.last_seen_at || !row.resources || row.uptime_seconds === null) {
    throw new ProjectHostdError('target_conflict', 'project-hostd snapshot is incomplete.');
  }
  return {
    connectionState: row.connection_state, credentialId: row.credential_id,
    deviceId: row.device_id, environmentId: row.environment_id, health: row.health,
    ...(row.host_id ? { hostId: row.host_id } : {}), hostdVersion: row.hostd_version,
    lastSeenAt: iso(row.last_seen_at), observedAt: iso(row.observed_at),
    partialMetrics: row.partial_metrics, protocolVersion: 1, resources: row.resources,
    runtimes: row.runtimes, schemaVersion: projectHostdSchemaVersion,
    sequence: Number(row.last_sequence), uptimeSeconds: Number(row.uptime_seconds)
  };
}

function scope(row: DeviceRow): ProjectHostdCredentialScope {
  return {
    credentialId: row.credential_id, deviceId: row.device_id,
    environmentId: row.environment_id, expiresAt: iso(row.expires_at),
    ...(row.host_id ? { hostId: row.host_id } : {}), ownerUserId: row.owner_user_id
  };
}

function publicCredential(
  input: IssueProjectHostdCredentialInput,
  credentialId: string,
  expiresAt: string,
  token: string
): ProjectHostdCredential {
  return {
    credentialId, deviceId: input.deviceId, environmentId: input.environmentId,
    expiresAt, ...(input.hostId ? { hostId: input.hostId } : {}),
    schemaVersion: projectHostdSchemaVersion, token
  };
}

function sameIssueRow(row: IssuedOperationRow, input: IssueProjectHostdCredentialInput) {
  return row.device_id === input.deviceId && row.environment_id === input.environmentId &&
    row.host_id === (input.hostId ?? null);
}

async function lock(client: DatabaseQueryClient, key: string) {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [key]);
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const selectDevice = `select
  d.owner_user_id, d.device_id::text, d.environment_id::text, d.host_id::text,
  d.connection_state, d.health, d.hostd_version, d.protocol_version, d.last_sequence,
  d.observed_at, d.last_seen_at, d.uptime_seconds, d.partial_metrics, d.resources, d.runtimes,
  c.credential_id::text, c.expires_at, c.revoked_at
 from project_hostd_devices d join project_hostd_credentials c
   on c.owner_user_id = d.owner_user_id and c.device_id = d.device_id and
      c.credential_id = d.current_credential_id`;

const returningDevice = `d.owner_user_id, d.device_id::text, d.environment_id::text,
 d.host_id::text, d.connection_state, d.health, d.hostd_version, d.protocol_version,
 d.last_sequence, d.observed_at, d.last_seen_at, d.uptime_seconds, d.partial_metrics,
 d.resources, d.runtimes, c.credential_id::text, c.expires_at, c.revoked_at`;

const updateDevicePrefix = `update project_hostd_devices d set`;
