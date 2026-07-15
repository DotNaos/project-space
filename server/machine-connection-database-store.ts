import { randomUUID } from "node:crypto";

import type { DatabaseQueryClient } from "./database/client";
import {
  assertSameMachineConnectorProfile,
  machineConnectorProfile,
  sameMachineConnectorProfile,
  type MachineConnectionStore,
  type MachineConnectRequestRecord,
  type MachineConnectRequestStatus,
  type MachineCredentialMutationResult,
  type MachineIdentityRecord,
} from "./machine-connection-contract";

export interface TransactionalDatabaseQueryClient extends DatabaseQueryClient {
  transaction<Result>(
    operation: (client: DatabaseQueryClient) => Promise<Result>,
  ): Promise<Result>;
}

type ClientSource =
  | TransactionalDatabaseQueryClient
  | PromiseLike<TransactionalDatabaseQueryClient>
  | (() =>
    | TransactionalDatabaseQueryClient
    | PromiseLike<TransactionalDatabaseQueryClient>);

export interface MachineConnectionDatabaseStoreOptions {
  createId?: () => string;
  credentialTtlSeconds?: number;
}

interface RequestRow {
  approval_challenge: unknown;
  approved_at: unknown;
  approved_by_user_id: unknown;
  architecture: unknown;
  client_version: unknown;
  consumed_at: unknown;
  connector_channel: unknown;
  connector_source: unknown;
  created_at: unknown;
  denied_at: unknown;
  expires_at: unknown;
  hostname: unknown;
  id: unknown;
  name: unknown;
  operating_system: unknown;
  poll_token_hash: unknown;
  public_key: unknown;
  status: unknown;
}

interface IdentityRow {
  architecture: unknown;
  client_version: unknown;
  connector_channel: unknown;
  connector_source: unknown;
  created_at: unknown;
  current_credential_id: unknown;
  hostname: unknown;
  id: unknown;
  last_seen_at: unknown;
  name: unknown;
  operating_system: unknown;
  owner_user_id: unknown;
  public_key: unknown;
  revoked_at: unknown;
}

interface MachineRow extends IdentityRow {
  credential_expires_at: unknown;
  credential_hash: unknown;
  effective_revoked_at: unknown;
}

interface CredentialLockRow {
  credential_expired: unknown;
  credential_id: unknown;
  credential_matches: unknown;
  credential_revoked_at: unknown;
}

const maximumCredentialTtlSeconds = 365 * 24 * 60 * 60;
const requestCleanupBatchSize = 500;
const requestStatuses = ["pending", "approved", "denied", "consumed", "expired"] as const;
const architectures = ["amd64", "arm64"] as const;
const operatingSystems = ["darwin", "linux", "windows"] as const;

const requestColumns = `id, poll_token_hash, public_key, name, hostname,
  operating_system, architecture, client_version, status, approval_challenge,
  approved_by_user_id, created_at, expires_at, approved_at, denied_at, consumed_at,
  connector_channel, connector_source`;
const identityColumns = `id, owner_user_id, public_key, name, hostname,
  operating_system, architecture, client_version, created_at, last_seen_at, revoked_at,
  current_credential_id, connector_channel, connector_source`;
const qualifiedIdentityColumns = `mi.id, mi.owner_user_id, mi.public_key, mi.name,
  mi.hostname, mi.operating_system, mi.architecture, mi.client_version,
  mi.created_at, mi.last_seen_at, mi.revoked_at, mi.current_credential_id,
  mi.connector_channel, mi.connector_source`;

function requiredString(value: unknown, column: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${column} returned by the database.`);
  return value;
}

const optionalString = (value: unknown, column: string) => value === null ? undefined : requiredString(value, column);

function timestamp(value: unknown, column: string) {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new Error(`Invalid ${column} returned by the database.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid ${column} returned by the database.`);
  }
  return parsed.toISOString();
}

const optionalTimestamp = (value: unknown, column: string) => value === null ? undefined : timestamp(value, column);

function enumValue<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  column: string,
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value))
    throw new Error(`Invalid ${column} returned by the database.`);
  return value as Value;
}

function hash(value: unknown, column: string) {
  const result = requiredString(value, column);
  if (!/^[0-9a-f]{64}$/.test(result))
    throw new Error(`Invalid ${column} returned by the database.`);
  return result;
}

function booleanValue(value: unknown, column: string) {
  if (typeof value !== "boolean")
    throw new Error(`Invalid ${column} returned by the database.`);
  return value;
}

function mapRequest(row: RequestRow): MachineConnectRequestRecord {
  return {
    approvalChallenge: optionalString(row.approval_challenge, "approval_challenge"),
    approvedAt: optionalTimestamp(row.approved_at, "approved_at"),
    approvedByUserId: optionalString(row.approved_by_user_id, "approved_by_user_id"),
    architecture: enumValue(row.architecture, architectures, "architecture"),
    clientVersion: requiredString(row.client_version, "client_version"),
    connectorProfile: machineConnectorProfile(row.connector_channel, row.connector_source),
    consumedAt: optionalTimestamp(row.consumed_at, "consumed_at"),
    createdAt: timestamp(row.created_at, "created_at"),
    deniedAt: optionalTimestamp(row.denied_at, "denied_at"),
    expiresAt: timestamp(row.expires_at, "expires_at"),
    hostname: requiredString(row.hostname, "hostname"),
    id: requiredString(row.id, "id"),
    name: requiredString(row.name, "name"),
    operatingSystem: enumValue(
      row.operating_system,
      operatingSystems,
      "operating_system",
    ),
    pollTokenHash: hash(row.poll_token_hash, "poll_token_hash"),
    publicKey: requiredString(row.public_key, "public_key"),
    status: enumValue(row.status, requestStatuses, "status"),
  };
}

function mapIdentity(row: IdentityRow, credentialHash: string): MachineIdentityRecord {
  return {
    architecture: enumValue(row.architecture, architectures, "architecture"),
    clientVersion: requiredString(row.client_version, "client_version"),
    connectorProfile: machineConnectorProfile(row.connector_channel, row.connector_source),
    createdAt: timestamp(row.created_at, "created_at"),
    credentialHash,
    hostname: requiredString(row.hostname, "hostname"),
    id: requiredString(row.id, "id"),
    lastSeenAt: optionalTimestamp(row.last_seen_at, "last_seen_at"),
    name: requiredString(row.name, "name"),
    operatingSystem: enumValue(
      row.operating_system,
      operatingSystems,
      "operating_system",
    ),
    ownerUserId: requiredString(row.owner_user_id, "owner_user_id"),
    publicKey: requiredString(row.public_key, "public_key"),
    revokedAt: optionalTimestamp(row.revoked_at, "revoked_at"),
  };
}

function normalizeTtl(value: number | undefined) {
  const ttl = value ?? maximumCredentialTtlSeconds;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > maximumCredentialTtlSeconds) {
    throw new Error(
      `credentialTtlSeconds must be between 1 and ${maximumCredentialTtlSeconds}.`,
    );
  }
  return ttl;
}

async function runTransaction<Result>(
  client: TransactionalDatabaseQueryClient,
  operation: (transaction: DatabaseQueryClient) => Promise<Result>,
) {
  return client.transaction(operation);
}

function assertEnrollmentMatchesRequest(
  request: MachineConnectRequestRecord,
  machine: MachineIdentityRecord,
) {
  if (
    !machineMatchesRequest(request, machine) ||
    request.status !== "consumed" ||
    !request.consumedAt
  ) {
    throw new Error("Machine enrollment does not match its approved request.");
  }
  hash(machine.credentialHash, "credential_hash");
}

function machineMatchesRequest(
  request: MachineConnectRequestRecord,
  machine: MachineIdentityRecord,
) {
  return (
    request.publicKey === machine.publicKey &&
    request.name === machine.name &&
    request.hostname === machine.hostname &&
    request.operatingSystem === machine.operatingSystem &&
    request.architecture === machine.architecture &&
    request.clientVersion === machine.clientVersion &&
    sameMachineConnectorProfile(request.connectorProfile, machine.connectorProfile) &&
    request.approvedByUserId === machine.ownerUserId
  );
}

// Schema contract: machine_identities.current_credential_id is a nullable UUID
// while an identity is first enrolled. A composite foreign key from
// (current_credential_id, id) to connector_credentials (id, machine_id) must
// enforce that the pointer always names that identity's bound credential.
export class DatabaseMachineConnectionStore implements MachineConnectionStore {
  private readonly createId: () => string;
  private readonly credentialTtlSeconds: number;
  private readonly resolveClient: () => Promise<TransactionalDatabaseQueryClient>;

  constructor(
    source: ClientSource,
    options: MachineConnectionDatabaseStoreOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
    this.credentialTtlSeconds = normalizeTtl(options.credentialTtlSeconds);
    this.resolveClient = async () => {
      const client = await Promise.resolve(
        typeof source === "function" ? source() : source,
      );
      if (typeof client.transaction !== "function") {
        throw new Error("Machine connection database client must support transactions.");
      }
      return client;
    };
  }

  async createRequest(request: MachineConnectRequestRecord) {
    const client = await this.resolveClient();
    await client.query(
      `insert into machine_connection_requests (
         id, poll_token_hash, public_key, name, hostname, operating_system,
         architecture, client_version, status, approval_challenge,
         approved_by_user_id, created_at, expires_at, approved_at, denied_at, consumed_at,
         connector_channel, connector_source
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18
       )`,
      [
        request.id,
        request.pollTokenHash,
        request.publicKey,
        request.name,
        request.hostname,
        request.operatingSystem,
        request.architecture,
        request.clientVersion,
        request.status,
        request.approvalChallenge ?? null,
        request.approvedByUserId ?? null,
        request.createdAt,
        request.expiresAt,
        request.approvedAt ?? null,
        request.deniedAt ?? null,
        request.consumedAt ?? null,
        request.connectorProfile?.channel ?? null,
        request.connectorProfile?.source ?? null,
      ],
    );
  }

  async getRequest(id: string) {
    const client = await this.resolveClient();
    const result = await client.query<RequestRow>(
      `select ${requestColumns}
         from machine_connection_requests
        where id = $1`,
      [id],
    );
    return result.rows[0] ? mapRequest(result.rows[0]) : null;
  }

  async cleanupOldRequests() {
    const client = await this.resolveClient();
    const result = await client.query<{ removed: number }>(
      `with expired_requests as (
         select id
           from machine_connection_requests
          where expires_at <= now() - interval '24 hours'
          order by expires_at, id
          for update skip locked
          limit $1
       )
       delete from machine_connection_requests as request
        using expired_requests
        where request.id = expired_requests.id
       returning 1 as removed`,
      [requestCleanupBatchSize],
    );
    const removed = result.rowCount ?? result.rows.length;
    if (
      !Number.isSafeInteger(removed) ||
      removed < 0 ||
      removed > requestCleanupBatchSize
    ) {
      throw new Error("Machine request cleanup result was invalid.");
    }
    return removed;
  }

  async updateRequestIfStatus(
    request: MachineConnectRequestRecord,
    expectedStatus: MachineConnectRequestStatus,
    unexpiredAt?: string,
  ) {
    const client = await this.resolveClient();
    const result = await client.query<{
      expired_by_boundary: unknown;
      status: unknown;
    }>(
      `update machine_connection_requests
          set status = case
                when $9::timestamptz is not null and expires_at <= $9::timestamptz
                  then 'expired'
                else $3
              end,
              approval_challenge = case when $9::timestamptz is not null
                and expires_at <= $9::timestamptz then approval_challenge else $4 end,
              approved_at = case when $9::timestamptz is not null
                and expires_at <= $9::timestamptz then approved_at else $5 end,
              approved_by_user_id = case when $9::timestamptz is not null
                and expires_at <= $9::timestamptz then approved_by_user_id else $6 end,
              denied_at = case when $9::timestamptz is not null
                and expires_at <= $9::timestamptz then denied_at else $7 end,
              consumed_at = case when $9::timestamptz is not null
                and expires_at <= $9::timestamptz then consumed_at else $8 end
        where id = $1 and status = $2
      returning status,
                ($9::timestamptz is not null
                  and expires_at <= $9::timestamptz) as expired_by_boundary`,
      [
        request.id,
        expectedStatus,
        request.status,
        request.approvalChallenge ?? null,
        request.approvedAt ?? null,
        request.approvedByUserId ?? null,
        request.deniedAt ?? null,
        request.consumedAt ?? null,
        unexpiredAt ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) return "status_mismatch";
    enumValue(row.status, requestStatuses, "status");
    return booleanValue(row.expired_by_boundary, "expired_by_boundary")
      ? "expired"
      : "updated";
  }

  async consumeRequestAndUpsertMachine(
    request: MachineConnectRequestRecord,
    machine: MachineIdentityRecord,
    unexpiredAt: string,
  ) {
    assertEnrollmentMatchesRequest(request, machine);
    const client = await this.resolveClient();
    return runTransaction(client, async (transaction) => {
      const requestResult = await transaction.query<RequestRow>(
        `select ${requestColumns}
           from machine_connection_requests
          where id = $1
          for update`,
        [request.id],
      );
      const current = requestResult.rows[0] ? mapRequest(requestResult.rows[0]) : null;
      if (!current || current.status !== "approved") {
        return { status: "request_unavailable" as const };
      }
      const expired = await transaction.query<{ id: string }>(
        `update machine_connection_requests
            set status = 'expired'
          where id = $1 and status = 'approved'
            and expires_at <= $2::timestamptz
        returning id`,
        [request.id, unexpiredAt],
      );
      if (expired.rows[0]) return { status: "expired" as const };

      if (!machineMatchesRequest(current, machine)) {
        throw new Error("Locked machine request does not match the enrollment.");
      }

      await transaction.query("select pg_advisory_xact_lock(hashtext($1))", [
        machine.publicKey,
      ]);
      const existingResult = await transaction.query<IdentityRow>(
        `select ${identityColumns}
           from machine_identities
          where public_key = $1
          for update`,
        [machine.publicKey],
      );
      const existing = existingResult.rows[0];
      if (existing && requiredString(existing.owner_user_id, "owner_user_id") !== machine.ownerUserId) {
        await this.consumeRequest(transaction, request);
        return { status: "key_conflict" as const };
      }
      if (existing) {
        assertSameMachineConnectorProfile(
          machineConnectorProfile(existing.connector_channel, existing.connector_source),
          machine.connectorProfile,
        );
      }

      const identityResult = existing
        ? await transaction.query<IdentityRow>(
            `update machine_identities
                set name = $2, hostname = $3, operating_system = $4,
                    architecture = $5, client_version = $6,
                    last_seen_at = null, revoked_at = null
              where id = $1 and owner_user_id = $7 and public_key = $8
            returning ${identityColumns}`,
            [
              requiredString(existing.id, "id"),
              machine.name,
              machine.hostname,
              machine.operatingSystem,
              machine.architecture,
              machine.clientVersion,
              machine.ownerUserId,
              machine.publicKey,
            ],
          )
        : await transaction.query<IdentityRow>(
            `insert into machine_identities (
               id, owner_user_id, public_key, name, hostname, operating_system,
               architecture, client_version, created_at, connector_channel, connector_source
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             returning ${identityColumns}`,
            [
              machine.id,
              machine.ownerUserId,
              machine.publicKey,
              machine.name,
              machine.hostname,
              machine.operatingSystem,
              machine.architecture,
              machine.clientVersion,
              machine.createdAt,
              machine.connectorProfile?.channel ?? null,
              machine.connectorProfile?.source ?? null,
            ],
          );
      const identity = identityResult.rows[0];
      if (!identity) throw new Error("Machine identity could not be persisted.");
      const machineId = requiredString(identity.id, "id");
      const membershipId = this.createId();
      const credentialId = this.createId();

      await transaction.query(
        `insert into machine_memberships (id, machine_id, user_id, role)
         values ($1, $2, $3, 'owner')
         on conflict (machine_id, user_id) do update set
           role = 'owner', updated_at = $4::timestamptz`,
        [membershipId, machineId, machine.ownerUserId, machine.createdAt],
      );
      await transaction.query(
        `update connector_credentials
            set revoked_at = coalesce(revoked_at, $2::timestamptz)
          where machine_id = $1 and revoked_at is null`,
        [machineId, machine.createdAt],
      );
      const credentialResult = await transaction.query<{ id: string }>(
        `insert into connector_credentials (
           id, owner_user_id, token_hash, expected_machine_id, machine_id,
           created_at, expires_at
         ) values (
           $1, $2, $3, $4, $4, $5::timestamptz,
           $5::timestamptz + ($6 * interval '1 second')
         )
         returning id`,
        [
          credentialId,
          machine.ownerUserId,
          machine.credentialHash,
          machineId,
          machine.createdAt,
          this.credentialTtlSeconds,
        ],
      );
      if (credentialResult.rows[0]?.id !== credentialId) {
        throw new Error("Machine credential could not be persisted.");
      }
      const currentCredentialResult = await transaction.query<{ id: string }>(
        `update machine_identities
            set current_credential_id = $2
          where id = $1 and owner_user_id = $3 and public_key = $4
        returning id`,
        [machineId, credentialId, machine.ownerUserId, machine.publicKey],
      );
      if (!currentCredentialResult.rows[0]) {
        throw new Error("Current machine credential could not be assigned.");
      }
      await this.consumeRequest(transaction, request);
      return {
        machine: mapIdentity(identity, machine.credentialHash),
        status: existing ? ("rotated" as const) : ("created" as const),
      };
    });
  }

  async getMachine(id: string) {
    const client = await this.resolveClient();
    const result = await client.query<MachineRow>(
      `select ${qualifiedIdentityColumns},
              credential.token_hash as credential_hash,
              credential.expires_at as credential_expires_at,
              coalesce(mi.revoked_at, credential.revoked_at,
                case when credential.expires_at <= now() then credential.expires_at end
              ) as effective_revoked_at
         from machine_identities mi
         join machine_memberships membership
           on membership.machine_id = mi.id
          and membership.user_id = mi.owner_user_id
          and membership.role = 'owner'
         join connector_credentials credential
           on credential.id = mi.current_credential_id
          and credential.machine_id = mi.id
          and credential.expected_machine_id = mi.id
        where mi.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    timestamp(row.credential_expires_at, "credential_expires_at");
    return mapIdentity(
      { ...row, revoked_at: row.effective_revoked_at },
      hash(row.credential_hash, "credential_hash"),
    );
  }

  async markMachineOnline(
    machineId: string,
    credentialHash: string,
    lastSeenAt: string,
  ) {
    return this.mutateCredential(machineId, credentialHash, lastSeenAt, "online");
  }

  async revokeMachine(
    machineId: string,
    credentialHash: string,
    revokedAt: string,
  ) {
    return this.mutateCredential(machineId, credentialHash, revokedAt, "revoke");
  }

  private async consumeRequest(
    transaction: DatabaseQueryClient,
    request: MachineConnectRequestRecord,
  ) {
    const result = await transaction.query<{ id: string }>(
      `update machine_connection_requests
          set status = 'consumed', consumed_at = $2::timestamptz
        where id = $1 and status = 'approved'
      returning id`,
      [request.id, request.consumedAt],
    );
    if (!result.rows[0]) throw new Error("Machine request could not be consumed.");
  }

  private async mutateCredential(
    machineId: string,
    credentialHash: string,
    mutationAt: string,
    operation: "online" | "revoke",
  ): Promise<MachineCredentialMutationResult> {
    hash(credentialHash, "credential_hash");
    const client = await this.resolveClient();
    return runTransaction(client, async (transaction) => {
      const identityResult = await transaction.query<{
        current_credential_id: unknown;
        revoked_at: unknown;
      }>(
        `select revoked_at, current_credential_id
           from machine_identities
          where id = $1
          for update`,
        [machineId],
      );
      const identity = identityResult.rows[0];
      if (!identity) return "invalid";
      const currentCredentialId = requiredString(
        identity.current_credential_id,
        "machine_identity.current_credential_id",
      );
      const credentialResult = await transaction.query<CredentialLockRow>(
        `select id as credential_id, revoked_at as credential_revoked_at,
                token_hash = $3 as credential_matches,
                expires_at <= $4::timestamptz as credential_expired
           from connector_credentials
          where id = $2 and machine_id = $1 and expected_machine_id = $1
          for update`,
        [machineId, currentCredentialId, credentialHash, mutationAt],
      );
      const credential = credentialResult.rows[0];
      if (!credential) return "invalid";
      const identityRevokedAt = optionalTimestamp(
        identity.revoked_at,
        "machine_identity.revoked_at",
      );
      const credentialId = requiredString(credential.credential_id, "credential_id");
      const credentialMatches = booleanValue(
        credential.credential_matches,
        "credential_matches",
      );
      const credentialExpired = booleanValue(
        credential.credential_expired,
        "credential_expired",
      );
      const credentialRevokedAt = optionalTimestamp(
        credential.credential_revoked_at,
        "connector_credential.revoked_at",
      );
      if (!credentialMatches) return "invalid";
      if (
        identityRevokedAt !== undefined ||
        credentialRevokedAt !== undefined ||
        credentialExpired
      ) {
        return "revoked";
      }

      const credentialMutation = operation === "online"
        ? `update connector_credentials
              set last_seen_at = $3::timestamptz
            where id = $1 and token_hash = $2 and revoked_at is null
              and expires_at > $3::timestamptz
          returning id`
        : `update connector_credentials
              set revoked_at = $3::timestamptz
            where id = $1 and token_hash = $2 and revoked_at is null
          returning id`;
      const credentialUpdate = await transaction.query<{ id: string }>(
        credentialMutation,
        [credentialId, credentialHash, mutationAt],
      );
      if (!credentialUpdate.rows[0]) {
        throw new Error("Credential changed during an atomic mutation.");
      }
      const identityUpdate = await transaction.query<{ id: string }>(
        operation === "online"
          ? `update machine_identities
                set last_seen_at = $2::timestamptz
              where id = $1 and revoked_at is null
            returning id`
          : `update machine_identities
                set revoked_at = $2::timestamptz
              where id = $1 and revoked_at is null
            returning id`,
        [machineId, mutationAt],
      );
      if (!identityUpdate.rows[0]) {
        throw new Error("Machine identity changed during an atomic mutation.");
      }
      return "updated";
    });
  }
}
