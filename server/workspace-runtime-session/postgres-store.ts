import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { DatabaseQueryClient } from '../database/client';
import {
  workspaceRuntimeSessionSchemaVersion,
  type WorkspaceRuntimeCredential,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeRegistration,
  type WorkspaceRuntimeSessionSnapshot
} from '../../src/shared/workspace-runtime-session-api';
import type {
  IssueRuntimeCredentialInput,
  RuntimeCredentialScope,
  RuntimeSessionStore
} from './contracts';
import { RuntimeSessionError } from './contracts';
import { validateCredentialIssue } from './validation';

interface RuntimeRow {
  branch: string;
  capabilities: string[];
  commit: string;
  connection_state: WorkspaceRuntimeSessionSnapshot['connectionState'] | 'superseded';
  current_credential_id: string;
  current_session_id: string | null;
  dev_servers: WorkspaceRuntimeSessionSnapshot['devServers'];
  environment_id: string;
  expires_at: Date | string;
  generation: string;
  last_event_at: Date | string;
  last_heartbeat_at: Date | string;
  last_sequence: string | number;
  lifecycle_state: WorkspaceRuntimeSessionSnapshot['lifecycleState'];
  log_pointer: string | null;
  manifest_digest: string;
  owner_user_id: string;
  revoked_at: Date | string | null;
  runtime_version: string;
  telemetry: WorkspaceRuntimeSessionSnapshot['telemetry'] | null;
  workspace_id: string;
}

interface EventRow { event_id: string; fingerprint_sha256: string; sequence: string | number }

export class PostgresRuntimeSessionStore implements RuntimeSessionStore {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly createCredentialId = randomUUID,
    private readonly createToken = () => randomBytes(32).toString('base64url')
  ) {
    if (!client.transaction) throw new Error('Workspace Runtime session store requires transactions.');
  }

  async issue(input: IssueRuntimeCredentialInput) {
    const token = this.createToken();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').byteLength !== 32) {
      throw new Error('Runtime credential token must contain 32 random bytes.');
    }
    const credentialId = this.createCredentialId();
    const ttl = validateCredentialIssue(input);
    return this.transaction(async (client) => {
      await lockLaunchOperation(client, input.ownerUserId, input.operationId);
      await lockWorkspace(client, input.ownerUserId, input.workspaceId);
      const operation = await client.query<IssuedOperationRow>(
        `select c.workspace_id, c.environment_id::text, c.generation::text, c.capabilities,
                g.branch, g.commit, g.manifest_digest, g.runtime_version
         from workspace_runtime_credentials c join workspace_runtime_generations g
           on g.owner_user_id = c.owner_user_id and g.workspace_id = c.workspace_id and
              g.environment_id = c.environment_id and g.generation = c.generation
         where c.owner_user_id = $1 and c.operation_id = $2 for update`,
        [input.ownerUserId, input.operationId]
      );
      if (operation.rows[0]) {
        if (!sameIssue(operation.rows[0], input)) {
          throw new RuntimeSessionError('replay_conflict', 'Runtime launch operation identity changed.');
        }
        throw new RuntimeSessionError('operation_in_progress', 'Runtime launch operation is already in progress.');
      }
      const current = await client.query<RuntimeRow>(
        `${selectRuntime} where g.owner_user_id = $1 and g.workspace_id = $2 and g.superseded_at is null for update`,
        [input.ownerUserId, input.workspaceId]
      );
      const prior = current.rows[0];
      if (prior && prior.generation === input.generation &&
        (prior.environment_id !== input.environmentId || prior.branch !== input.branch ||
          prior.commit !== input.commit || prior.manifest_digest !== input.manifestDigest ||
          prior.runtime_version !== input.runtimeVersion)) {
        throw new RuntimeSessionError('generation_replaced', 'Runtime source binding changed.');
      }
      if (prior && prior.generation === input.generation && (!prior.revoked_at || prior.current_session_id)) {
        throw new RuntimeSessionError('generation_replaced', 'Runtime generation already has an active session credential.');
      }
      if (prior && prior.generation !== input.generation) {
        await client.query(
          `update workspace_runtime_generations set connection_state = 'superseded', superseded_at = now(),
             current_session_id = null, updated_at = now()
           where owner_user_id = $1 and workspace_id = $2 and superseded_at is null`,
          [input.ownerUserId, input.workspaceId]
        );
        await client.query(
          `update workspace_runtime_credentials set revoked_at = coalesce(revoked_at, now())
           where owner_user_id = $1 and workspace_id = $2 and revoked_at is null`,
          [input.ownerUserId, input.workspaceId]
        );
      } else if (prior) {
        await client.query(
          `update workspace_runtime_credentials set revoked_at = coalesce(revoked_at, now())
           where owner_user_id = $1 and credential_id = $2::uuid`,
          [input.ownerUserId, prior.current_credential_id]
        );
      }
      await client.query(
        `insert into workspace_runtime_generations (
           owner_user_id, workspace_id, environment_id, generation, branch, commit,
           manifest_digest, runtime_version, connection_state
         ) values ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, 'connecting')
         on conflict (owner_user_id, workspace_id, generation) do update set
           connection_state = 'connecting', current_session_id = null, updated_at = now()`,
        [input.ownerUserId, input.workspaceId, input.environmentId, input.generation,
          input.branch, input.commit, input.manifestDigest, input.runtimeVersion]
      );
      const issued = await client.query<{ expires_at: Date | string }>(
        `insert into workspace_runtime_credentials (
           owner_user_id, workspace_id, environment_id, generation, credential_id,
           operation_id, token_hash, capabilities, expires_at
         ) values ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, now() + ($9 * interval '1 second'))
         returning expires_at`,
        [input.ownerUserId, input.workspaceId, input.environmentId, input.generation,
          credentialId, input.operationId, hash(token), input.capabilities, ttl]
      );
      await client.query(
        `update workspace_runtime_generations set current_credential_id = $4::uuid, updated_at = now()
         where owner_user_id = $1 and workspace_id = $2 and generation = $3::uuid and superseded_at is null`,
        [input.ownerUserId, input.workspaceId, input.generation, credentialId]
      );
      const credential: WorkspaceRuntimeCredential = {
        capabilities: [...input.capabilities], credentialId, environmentId: input.environmentId,
        expiresAt: iso(issued.rows[0]!.expires_at), generation: input.generation,
        schemaVersion: workspaceRuntimeSessionSchemaVersion, token, workspaceId: input.workspaceId
      };
      return { credential, ...(prior ? { replacedCredentialId: prior.current_credential_id } : {}) };
    });
  }

  async authenticate(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await this.client.query<RuntimeRow>(
      `${selectRuntime}
       where c.token_hash = $1 and c.revoked_at is null and c.expires_at > now()
         and g.superseded_at is null and g.current_credential_id = c.credential_id`,
      [hash(token)]
    );
    const row = result.rows[0];
    if (!row) return null;
    await this.client.query(
      `update workspace_runtime_credentials set last_authenticated_at = now()
       where owner_user_id = $1 and credential_id = $2::uuid and revoked_at is null`,
      [row.owner_user_id, row.current_credential_id]
    );
    return scope(row);
  }

  register(runtimeScope: RuntimeCredentialScope, sessionId: string, receivedAt: string, registration: WorkspaceRuntimeRegistration) {
    return this.transaction(async (client) => {
      const row = await currentForUpdate(client, runtimeScope);
      if (row.lifecycle_state === 'stopped') {
        throw new RuntimeSessionError('generation_replaced', 'Stopped Runtime generation is terminal.');
      }
      if (!sameRegistration(row, registration) || registration.resumeAfterSequence > Number(row.last_sequence)) {
        throw new RuntimeSessionError('sequence_conflict', 'Runtime registration evidence changed.');
      }
      const replacedSessionId = row.current_session_id ?? undefined;
      const updated = await client.query<RuntimeRow>(
        `${updateRuntimePrefix}
           set current_session_id = $6::uuid, connection_state = 'online', registered_at = coalesce(registered_at, $7::timestamptz),
               last_event_at = $7::timestamptz, last_heartbeat_at = $7::timestamptz,
               disconnected_at = null, updated_at = $7::timestamptz
         where g.owner_user_id = $1 and g.workspace_id = $2 and g.environment_id = $3::uuid and
               g.generation = $4::uuid and g.current_credential_id = $5::uuid and g.superseded_at is null
         returning ${returningRuntime}`,
        [runtimeScope.ownerUserId, runtimeScope.workspaceId, runtimeScope.environmentId,
          runtimeScope.generation, runtimeScope.credentialId, sessionId, receivedAt]
      );
      return { ...(replacedSessionId ? { replacedSessionId } : {}), snapshot: snapshot(updated.rows[0]!) };
    });
  }

  append(runtimeScope: RuntimeCredentialScope, sessionId: string, receivedAt: string, event: WorkspaceRuntimeEvent) {
    return this.transaction(async (client) => {
      const row = await currentForUpdate(client, runtimeScope, sessionId);
      if (row.connection_state !== 'online' || row.lifecycle_state === 'stopped') {
        throw new RuntimeSessionError('generation_replaced', 'Runtime session is not active.');
      }
      requireCapability(runtimeScope, event);
      if (Date.parse(event.observedAt) > Date.parse(receivedAt) + 5 * 60_000) {
        throw new RuntimeSessionError('invalid_message', 'Runtime event observation is too far in the future.');
      }
      const fingerprint = hash(JSON.stringify(event));
      const prior = await client.query<EventRow>(
        `select event_id, sequence, fingerprint_sha256 from workspace_runtime_events
         where owner_user_id = $1 and workspace_id = $2 and generation = $3::uuid and
               (event_id = $4 or sequence = $5) for update`,
        [runtimeScope.ownerUserId, runtimeScope.workspaceId, runtimeScope.generation, event.eventId, event.sequence]
      );
      if (prior.rows.length) {
        const exact = prior.rows.length === 1 && prior.rows[0]!.event_id === event.eventId &&
          Number(prior.rows[0]!.sequence) === event.sequence && prior.rows[0]!.fingerprint_sha256 === fingerprint;
        if (!exact) throw new RuntimeSessionError('replay_conflict', 'Runtime event replay changed.');
        return { replayed: true, snapshot: snapshot(row) };
      }
      if (event.sequence !== Number(row.last_sequence) + 1) {
        throw new RuntimeSessionError('sequence_conflict', 'Runtime event sequence is not contiguous.');
      }
      const changes = eventChanges(row, event);
      const updated = await client.query<RuntimeRow>(
        `${updateRuntimePrefix} set ${changes.sql}, last_sequence = $8, last_event_at = $7::timestamptz, updated_at = $7::timestamptz
         where g.owner_user_id = $1 and g.workspace_id = $2 and g.environment_id = $3::uuid and g.generation = $4::uuid and
               g.current_credential_id = $5::uuid and g.current_session_id = $6::uuid and g.superseded_at is null
         returning ${returningRuntime}`,
        [runtimeScope.ownerUserId, runtimeScope.workspaceId, runtimeScope.environmentId,
          runtimeScope.generation, runtimeScope.credentialId, sessionId, receivedAt, event.sequence, ...changes.values]
      );
      if (!updated.rows[0]) throw new RuntimeSessionError('generation_replaced', 'Runtime session was replaced.');
      await client.query(
        `insert into workspace_runtime_events (
           owner_user_id, workspace_id, generation, event_id, sequence, fingerprint_sha256,
           event_type, safe_payload, observed_at, received_at
         ) values ($1, $2, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz)`,
        [runtimeScope.ownerUserId, runtimeScope.workspaceId, runtimeScope.generation,
          event.eventId, event.sequence, fingerprint, event.type, JSON.stringify(event), event.observedAt, receivedAt]
      );
      return { replayed: false, snapshot: snapshot(updated.rows[0]) };
    });
  }

  async disconnect(runtimeScope: RuntimeCredentialScope, sessionId: string, checkedAt: string) {
    await this.client.query(
      `update workspace_runtime_generations set connection_state = 'disconnected', disconnected_at = $7::timestamptz,
         last_event_at = $7::timestamptz, updated_at = $7::timestamptz
       where owner_user_id = $1 and workspace_id = $2 and environment_id = $3::uuid and generation = $4::uuid and
             current_credential_id = $5::uuid and current_session_id = $6::uuid and connection_state = 'online' and superseded_at is null`,
      [runtimeScope.ownerUserId, runtimeScope.workspaceId, runtimeScope.environmentId,
        runtimeScope.generation, runtimeScope.credentialId, sessionId, checkedAt]
    );
  }

  async list(ownerUserId: string) {
    const result = await this.client.query<RuntimeRow>(
      `${selectRuntime} where g.owner_user_id = $1 and g.superseded_at is null and g.current_session_id is not null`,
      [ownerUserId]
    );
    return result.rows.map(snapshot);
  }

  async markStale(staleBefore: string, checkedAt: string) {
    const result = await this.client.query<RuntimeRow>(
      `${updateRuntimePrefix} set connection_state = 'stale', last_event_at = $2::timestamptz, updated_at = $2::timestamptz
       where g.last_heartbeat_at < $1::timestamptz and g.connection_state in ('online', 'disconnected') and g.superseded_at is null
       returning ${returningRuntime}`,
      [staleBefore, checkedAt]
    );
    return result.rows.map((row) => ({ ownerUserId: row.owner_user_id, snapshot: snapshot(row) }));
  }

  async revoke(ownerUserId: string, workspaceId: string, credentialId: string) {
    await this.client.query(
      `update workspace_runtime_credentials set revoked_at = coalesce(revoked_at, now())
       where owner_user_id = $1 and workspace_id = $2 and credential_id = $3::uuid`,
      [ownerUserId, workspaceId, credentialId]
    );
  }

  private transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return this.client.transaction!(operation);
  }
}

async function currentForUpdate(client: DatabaseQueryClient, scope: RuntimeCredentialScope, sessionId?: string) {
  await lockWorkspace(client, scope.ownerUserId, scope.workspaceId);
  const result = await client.query<RuntimeRow>(
    `${selectRuntime} where g.owner_user_id = $1 and g.workspace_id = $2 and g.environment_id = $3::uuid and
       g.generation = $4::uuid and g.current_credential_id = $5::uuid and c.revoked_at is null and
       c.expires_at > now() and g.superseded_at is null
       ${sessionId ? 'and g.current_session_id = $6::uuid' : ''} for update`,
    [scope.ownerUserId, scope.workspaceId, scope.environmentId, scope.generation, scope.credentialId, ...(sessionId ? [sessionId] : [])]
  );
  const row = result.rows[0];
  if (!row) {
    throw new RuntimeSessionError('generation_replaced', 'Runtime authority changed or expired.');
  }
  return row;
}

function sameRegistration(row: RuntimeRow, registration: WorkspaceRuntimeRegistration) {
  return row.workspace_id === registration.workspaceId && row.environment_id === registration.environmentId &&
    row.generation === registration.generation && row.branch === registration.branch && row.commit === registration.commit &&
    row.manifest_digest === registration.manifestDigest && row.runtime_version === registration.runtimeVersion;
}

function eventChanges(row: RuntimeRow, event: WorkspaceRuntimeEvent) {
  if (event.type === 'runtime.heartbeat') return { sql: 'last_heartbeat_at = $7::timestamptz', values: [] };
  if (event.type === 'runtime.lifecycle') {
    if (!validTransition(row.lifecycle_state, event.state)) throw new RuntimeSessionError('sequence_conflict', 'Runtime lifecycle transition is invalid.');
    return { sql: `lifecycle_state = $9, connection_state = ${event.state === 'stopped' ? "'stopped'" : "'online'"}, stopped_at = ${event.state === 'stopped' ? '$7::timestamptz' : 'stopped_at'}`, values: [event.state] };
  }
  if (event.type === 'runtime.dev-servers') return { sql: 'dev_servers = $9::jsonb', values: [JSON.stringify(event.devServers)] };
  if (event.type === 'runtime.telemetry') return { sql: 'telemetry = $9::jsonb', values: [JSON.stringify({ cpuPercent: event.cpuPercent, memoryBytes: event.memoryBytes })] };
  return { sql: 'log_pointer = $9', values: [event.pointer] };
}

function requireCapability(scope: RuntimeCredentialScope, event: WorkspaceRuntimeEvent) {
  const capability = event.type === 'runtime.lifecycle' ? 'runtime.lifecycle' : event.type === 'runtime.heartbeat' ? 'runtime.heartbeat' :
    event.type === 'runtime.dev-servers' ? 'runtime.dev-servers' : event.type === 'runtime.telemetry' ? 'runtime.telemetry' : 'runtime.log-pointers';
  if (!scope.capabilities.includes(capability)) throw new RuntimeSessionError('authentication_failed', `Runtime credential lacks ${capability}.`);
}

function validTransition(current: RuntimeRow['lifecycle_state'], next: RuntimeRow['lifecycle_state']) {
  const transitions: Record<RuntimeRow['lifecycle_state'], RuntimeRow['lifecycle_state'][]> = {
    starting: ['starting', 'running', 'stopping', 'failed'], running: ['running', 'suspended', 'stopping', 'failed'],
    suspended: ['suspended', 'running', 'stopping', 'failed'], stopping: ['stopping', 'stopped', 'failed'],
    stopped: ['stopped'], failed: ['failed', 'stopping', 'stopped']
  };
  return transitions[current].includes(next);
}

function scope(row: RuntimeRow): RuntimeCredentialScope {
  return { branch: row.branch, capabilities: row.capabilities as RuntimeCredentialScope['capabilities'], commit: row.commit,
    credentialId: row.current_credential_id, environmentId: row.environment_id, expiresAt: iso(row.expires_at),
    generation: row.generation, manifestDigest: row.manifest_digest, ownerUserId: row.owner_user_id,
    runtimeVersion: row.runtime_version, workspaceId: row.workspace_id };
}

function snapshot(row: RuntimeRow): WorkspaceRuntimeSessionSnapshot {
  if (!row.current_session_id || row.connection_state === 'superseded') throw new RuntimeSessionError('generation_replaced', 'Runtime snapshot is not current.');
  return { branch: row.branch, capabilities: row.capabilities as WorkspaceRuntimeSessionSnapshot['capabilities'], commit: row.commit,
    connectionState: row.connection_state, devServers: row.dev_servers, environmentId: row.environment_id, expiresAt: iso(row.expires_at),
    generation: row.generation, lastEventAt: iso(row.last_event_at), lastHeartbeatAt: iso(row.last_heartbeat_at),
    lastSequence: Number(row.last_sequence), lifecycleState: row.lifecycle_state, manifestDigest: row.manifest_digest,
    runtimeVersion: row.runtime_version, schemaVersion: workspaceRuntimeSessionSchemaVersion, sessionId: row.current_session_id,
    workspaceId: row.workspace_id, ...(row.log_pointer ? { logPointer: row.log_pointer } : {}), ...(row.telemetry ? { telemetry: row.telemetry } : {}) };
}

async function lockWorkspace(client: DatabaseQueryClient, owner: string, workspace: string) {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-runtime:${owner}:${workspace}`]);
}

async function lockLaunchOperation(client: DatabaseQueryClient, owner: string, operationId: string) {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-runtime-operation:${owner}:${operationId}`]);
}

interface IssuedOperationRow {
  branch: string;
  capabilities: string[];
  commit: string;
  environment_id: string;
  generation: string;
  manifest_digest: string;
  runtime_version: string;
  workspace_id: string;
}

function sameIssue(left: IssuedOperationRow, right: IssueRuntimeCredentialInput) {
  return left.workspace_id === right.workspaceId && left.environment_id === right.environmentId &&
    left.generation === right.generation && left.branch === right.branch && left.commit === right.commit &&
    left.manifest_digest === right.manifestDigest && left.runtime_version === right.runtimeVersion &&
    [...left.capabilities].sort().join('\0') === [...right.capabilities].sort().join('\0');
}

function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

const selectRuntime = `select g.owner_user_id, g.workspace_id, g.environment_id::text, g.generation::text, g.branch, g.commit,
  g.manifest_digest, g.runtime_version, g.lifecycle_state, g.connection_state, g.current_session_id::text,
  g.current_credential_id::text, g.last_sequence, g.last_event_at, g.last_heartbeat_at, g.dev_servers, g.telemetry,
  g.log_pointer, c.capabilities, c.expires_at, c.operation_id, c.revoked_at from workspace_runtime_generations g join workspace_runtime_credentials c
  on c.owner_user_id = g.owner_user_id and c.workspace_id = g.workspace_id and
     c.environment_id = g.environment_id and c.generation = g.generation and
     c.credential_id = g.current_credential_id`;
const updateRuntimePrefix = 'update workspace_runtime_generations g';
const returningRuntime = `g.owner_user_id, g.workspace_id, g.environment_id::text, g.generation::text, g.branch, g.commit,
  g.manifest_digest, g.runtime_version, g.lifecycle_state, g.connection_state, g.current_session_id::text,
  g.current_credential_id::text, g.last_sequence, g.last_event_at, g.last_heartbeat_at, g.dev_servers, g.telemetry,
  g.log_pointer, (select capabilities from workspace_runtime_credentials c where c.owner_user_id = g.owner_user_id and
    c.workspace_id = g.workspace_id and c.environment_id = g.environment_id and c.generation = g.generation and
    c.credential_id = g.current_credential_id) capabilities,
  (select expires_at from workspace_runtime_credentials c where c.owner_user_id = g.owner_user_id and
    c.workspace_id = g.workspace_id and c.environment_id = g.environment_id and c.generation = g.generation and
    c.credential_id = g.current_credential_id) expires_at`;
