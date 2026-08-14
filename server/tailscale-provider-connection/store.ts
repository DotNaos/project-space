import { randomUUID } from 'node:crypto';

import type { DatabaseQueryClient } from '../database/client';
import type {
  EncryptedProviderCredentialEnvelope,
  ProviderCredential,
  ProviderCredentialVault
} from './credential-vault';

export type TailscaleProviderConnectionState = 'active' | 'revoked';
export type TailscaleProviderCredentials = ProviderCredential;

export interface TailscaleProviderConnectionStatus {
  connectionId: string;
  createdAt: string;
  ownerUserId: string;
  revision: number;
  revokedAt?: string;
  state: TailscaleProviderConnectionState;
  verifiedAt: string;
}

export interface ActiveTailscaleProviderConnection {
  credentials: TailscaleProviderCredentials;
  status: TailscaleProviderConnectionStatus;
}

export interface TailscaleProviderConnectionStore {
  readActive(ownerUserId: string): Promise<ActiveTailscaleProviderConnection | null>;
  readStatus(ownerUserId: string): Promise<TailscaleProviderConnectionStatus | null>;
  revoke(input: {
    actorId: string;
    ownerUserId: string;
  }): Promise<TailscaleProviderConnectionStatus | null>;
  saveVerified(input: {
    actorId: string;
    credentials: TailscaleProviderCredentials;
    ownerUserId: string;
    verifiedAt: string;
  }): Promise<TailscaleProviderConnectionStatus>;
}

interface ConnectionRow {
  connection_id: string;
  credential_ciphertext: string | null;
  credential_iv: string | null;
  credential_key_id: string | null;
  credential_tag: string | null;
  created_at: Date | string;
  owner_user_id: string;
  revision: number | string;
  revoked_at: Date | string | null;
  state: TailscaleProviderConnectionState;
  verified_at: Date | string;
}

export class PostgresTailscaleProviderConnectionStore implements TailscaleProviderConnectionStore {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly vault: Pick<ProviderCredentialVault, 'decrypt' | 'encrypt'>,
    private readonly createId: () => string = randomUUID
  ) {}

  async readStatus(ownerUserId: string): Promise<TailscaleProviderConnectionStatus | null> {
    const owner = requiredIdentifier(ownerUserId, 'owner user id');
    const result = await this.client.query<ConnectionRow>(
      `select connection_id, owner_user_id, state, revision, created_at, verified_at, revoked_at,
              credential_key_id, credential_ciphertext, credential_iv, credential_tag
         from tailscale_provider_connections
        where owner_user_id = $1`,
      [owner]
    );
    return result.rows[0] ? statusFromRow(result.rows[0]) : null;
  }

  async readActive(ownerUserId: string): Promise<ActiveTailscaleProviderConnection | null> {
    const owner = requiredIdentifier(ownerUserId, 'owner user id');
    const result = await this.client.query<ConnectionRow>(
      `select connection_id, owner_user_id, state, revision, created_at, verified_at, revoked_at,
              credential_key_id, credential_ciphertext, credential_iv, credential_tag
         from tailscale_provider_connections
        where owner_user_id = $1 and state = 'active'`,
      [owner]
    );
    const row = result.rows[0];
    if (!row) return null;
    const envelope = credentialEnvelope(row);
    return { credentials: this.vault.decrypt(envelope), status: statusFromRow(row) };
  }

  async saveVerified(input: {
    actorId: string;
    credentials: TailscaleProviderCredentials;
    ownerUserId: string;
    verifiedAt: string;
  }) {
    const owner = requiredIdentifier(input.ownerUserId, 'owner user id');
    const actor = requiredIdentifier(input.actorId, 'actor id');
    const verifiedAt = isoDate(input.verifiedAt);
    const credential = this.vault.encrypt(input.credentials);
    return this.transaction(async (client) => {
      const result = await client.query<ConnectionRow>(
        `insert into tailscale_provider_connections (
           connection_id, owner_user_id, state, revision,
           credential_key_id, credential_ciphertext, credential_iv, credential_tag,
           verified_at, revoked_at, created_at, updated_at
         ) values (
           $1::uuid, $2, 'active', 1, $3, $4, $5, $6, $7::timestamptz, null, now(), now()
         ) on conflict (owner_user_id) do update set
           state = 'active',
           revision = tailscale_provider_connections.revision + 1,
           credential_key_id = excluded.credential_key_id,
           credential_ciphertext = excluded.credential_ciphertext,
           credential_iv = excluded.credential_iv,
           credential_tag = excluded.credential_tag,
           verified_at = excluded.verified_at,
           revoked_at = null,
           updated_at = now()
         returning connection_id, owner_user_id, state, revision, created_at, verified_at, revoked_at,
                   credential_key_id, credential_ciphertext, credential_iv, credential_tag`,
        [this.createId(), owner, credential.keyId, credential.ciphertext, credential.iv,
          credential.tag, verifiedAt]
      );
      const row = result.rows[0];
      if (!row) throw new Error('The Tailscale provider connection could not be saved.');
      await client.query(
        `insert into tailscale_provider_connection_audits (
           connection_id, owner_user_id, actor_id, action, revision
         ) values ($1::uuid, $2, $3, 'connected', $4)`,
        [row.connection_id, owner, actor, numericRevision(row.revision)]
      );
      return statusFromRow(row);
    });
  }

  async revoke(input: { actorId: string; ownerUserId: string }) {
    const owner = requiredIdentifier(input.ownerUserId, 'owner user id');
    const actor = requiredIdentifier(input.actorId, 'actor id');
    return this.transaction(async (client) => {
      const result = await client.query<ConnectionRow>(
        `update tailscale_provider_connections
            set state = 'revoked', revision = revision + 1,
                credential_key_id = null, credential_ciphertext = null,
                credential_iv = null, credential_tag = null,
                revoked_at = now(), updated_at = now()
          where owner_user_id = $1 and state = 'active'
        returning connection_id, owner_user_id, state, revision, created_at, verified_at, revoked_at,
                  credential_key_id, credential_ciphertext, credential_iv, credential_tag`,
        [owner]
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `insert into tailscale_provider_connection_audits (
           connection_id, owner_user_id, actor_id, action, revision
         ) values ($1::uuid, $2, $3, 'revoked', $4)`,
        [row.connection_id, owner, actor, numericRevision(row.revision)]
      );
      return statusFromRow(row);
    });
  }

  private transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return this.client.transaction ? this.client.transaction(operation) : operation(this.client);
  }
}

function credentialEnvelope(row: ConnectionRow): EncryptedProviderCredentialEnvelope {
  if (!row.credential_key_id || !row.credential_ciphertext || !row.credential_iv || !row.credential_tag) {
    throw new Error('The active Tailscale provider credential is unavailable.');
  }
  return {
    ciphertext: row.credential_ciphertext,
    iv: row.credential_iv,
    keyId: row.credential_key_id,
    tag: row.credential_tag
  };
}

function statusFromRow(row: ConnectionRow): TailscaleProviderConnectionStatus {
  return {
    connectionId: requiredUuid(row.connection_id, 'connection id'),
    createdAt: isoDate(row.created_at),
    ownerUserId: requiredIdentifier(row.owner_user_id, 'owner user id'),
    revision: numericRevision(row.revision),
    ...(row.revoked_at ? { revokedAt: isoDate(row.revoked_at) } : {}),
    state: row.state,
    verifiedAt: isoDate(row.verified_at)
  };
}

function requiredIdentifier(value: string, label: string) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`The ${label} is invalid.`);
  return value;
}

function requiredUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function numericRevision(value: number | string) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('The Tailscale provider revision is invalid.');
  return revision;
}

function isoDate(value: Date | string) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('The Tailscale provider timestamp is invalid.');
  return parsed.toISOString();
}
