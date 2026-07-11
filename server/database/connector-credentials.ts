import { createHash, randomBytes } from 'node:crypto';

import type { DatabaseQueryClient } from './client';
import type {
  AuthenticateConnectorCredentialInput,
  AuthenticatedConnectorCredential,
  CreateConnectorCredentialInput,
  CreatedConnectorCredential,
  RevokeConnectorCredentialInput,
  StoredConnectorCredential,
  ConnectorCredentialStatus
} from './models';

interface ConnectorCredentialRow {
  created_at: Date | string;
  expires_at: Date | string;
  id: string;
  last_seen_at: Date | string | null;
  machine_id: string | null;
  owner_user_id: string;
  revoked_at: Date | string | null;
  status?: ConnectorCredentialStatus;
}

interface BoundConnectorCredentialRow {
  id: string;
  machine_id: string;
  owner_user_id: string;
}

export interface ConnectorCredentialRepositoryOptions {
  createId: () => string;
  createToken?: () => string;
}

const defaultTtlSeconds = 30 * 24 * 60 * 60;
const maximumTtlSeconds = 365 * 24 * 60 * 60;
const boundCredentialTtlSeconds = maximumTtlSeconds;
const ownerConstraintName = 'machine_memberships_one_owner_per_machine';

class AuthenticationRejectedError extends Error {}

function requireValue(value: string, name: string) {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${name} is required.`);
  }

  return normalized;
}

function normalizeTtl(ttlSeconds: number | undefined) {
  const ttl = ttlSeconds ?? defaultTtlSeconds;

  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > maximumTtlSeconds) {
    throw new Error(
      `ttlSeconds must be a positive integer no greater than ${maximumTtlSeconds}.`
    );
  }

  return ttl;
}

function hashToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIsoString(value: Date | string | null) {
  return value === null ? undefined : toIsoString(value);
}

function mapStoredCredential(row: ConnectorCredentialRow): StoredConnectorCredential {
  return {
    createdAt: toIsoString(row.created_at),
    expiresAt: toIsoString(row.expires_at),
    id: row.id,
    lastSeenAt: optionalIsoString(row.last_seen_at),
    machineId: row.machine_id ?? undefined,
    revokedAt: optionalIsoString(row.revoked_at),
    status: row.status ?? 'expired'
  };
}

function isOwnerConflict(error: unknown) {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const databaseError = error as { code?: unknown; constraint?: unknown };

  return (
    databaseError.code === '23505' && databaseError.constraint === ownerConstraintName
  );
}

async function runTransaction<Result>(
  client: DatabaseQueryClient,
  operation: (transaction: DatabaseQueryClient) => Promise<Result>
) {
  if (client.transaction) {
    return client.transaction(operation);
  }

  await client.query('begin');

  try {
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export class ConnectorCredentialRepository {
  private readonly createToken: () => string;

  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly options: ConnectorCredentialRepositoryOptions
  ) {
    this.createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async create(input: CreateConnectorCredentialInput): Promise<CreatedConnectorCredential> {
    const userId = requireValue(input.userId, 'userId');
    const ttlSeconds = normalizeTtl(input.ttlSeconds);
    const token = this.createToken();
    const tokenBytes = Buffer.from(token, 'base64url');

    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || tokenBytes.byteLength !== 32) {
      throw new Error('Connector credential tokens must contain at least 32 random bytes.');
    }

    const credential = await runTransaction(this.client, async (transaction) => {
      // An account only needs one unused enrollment at a time. Revoking older
      // unbound credentials makes "Generate" act like a safe replacement,
      // while already-installed machines keep their independent credentials.
      await transaction.query(
        `update connector_credentials
            set revoked_at = coalesce(revoked_at, now())
          where owner_user_id = $1
            and machine_id is null
            and revoked_at is null`,
        [userId]
      );

      const result = await transaction.query<ConnectorCredentialRow>(
        `insert into connector_credentials (id, owner_user_id, token_hash, expires_at)
         values ($1, $2, $3, now() + ($4 * interval '1 second'))
         returning id, owner_user_id, machine_id, expires_at`,
        [this.options.createId(), userId, hashToken(token), ttlSeconds]
      );

      return result.rows[0];
    });

    if (!credential) {
      throw new Error('The connector credential could not be created.');
    }

    return {
      expiresAt: new Date(credential.expires_at).toISOString(),
      id: credential.id,
      token,
      userId: credential.owner_user_id
    };
  }

  async authenticate(
    input: AuthenticateConnectorCredentialInput
  ): Promise<AuthenticatedConnectorCredential | null> {
    const machineId = requireValue(input.machineId, 'machineId');
    const token = input.token;

    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').byteLength !== 32) {
      return null;
    }

    const tokenHash = hashToken(token);

    try {
      return await runTransaction(this.client, async (transaction) => {
        const credentialResult = await transaction.query<ConnectorCredentialRow>(
          `select id, owner_user_id, machine_id, expires_at
             from connector_credentials
            where token_hash = $1
              and revoked_at is null
              and expires_at > now()
            for update`,
          [tokenHash]
        );
        const credential = credentialResult.rows[0];

        if (!credential || (credential.machine_id && credential.machine_id !== machineId)) {
          return null;
        }

        // Every credential row is locked above, while this advisory lock serializes
        // different credentials attempting to claim the same machine.
        await transaction.query('select pg_advisory_xact_lock(hashtext($1))', [machineId]);

        await transaction.query(
          `insert into machine_memberships (id, machine_id, user_id, role)
           values ($1, $2, $3, 'owner')
           on conflict (machine_id, user_id) do update set
             role = 'owner',
             updated_at = now()`,
          [this.options.createId(), machineId, credential.owner_user_id]
        );

        const boundResult = await transaction.query<BoundConnectorCredentialRow>(
          `update connector_credentials
              set machine_id = $2,
                  expires_at = case
                    when machine_id is null
                      then now() + ($3 * interval '1 second')
                    else expires_at
                  end,
                  last_seen_at = now()
            where id = $1
              and (machine_id is null or machine_id = $2)
              and revoked_at is null
              and expires_at > now()
          returning id, owner_user_id, machine_id`,
          [credential.id, machineId, boundCredentialTtlSeconds]
        );
        const bound = boundResult.rows[0];

        if (!bound) {
          throw new AuthenticationRejectedError();
        }

        return {
          credentialId: bound.id,
          machineId: bound.machine_id,
          userId: bound.owner_user_id
        };
      });
    } catch (error) {
      if (error instanceof AuthenticationRejectedError || isOwnerConflict(error)) {
        return null;
      }

      throw error;
    }
  }

  async list(userId: string): Promise<StoredConnectorCredential[]> {
    const result = await this.client.query<ConnectorCredentialRow>(
      `select id, owner_user_id, machine_id, created_at, expires_at, last_seen_at, revoked_at,
              case
                when revoked_at is not null then 'revoked'
                when expires_at <= now() then 'expired'
                when machine_id is null then 'pending'
                else 'active'
              end as status
         from connector_credentials
        where owner_user_id = $1
        order by (revoked_at is null and expires_at > now()) desc, created_at desc
        limit 100`,
      [requireValue(userId, 'userId')]
    );

    return result.rows.map(mapStoredCredential);
  }

  async revoke(input: RevokeConnectorCredentialInput) {
    const result = await this.client.query<{ id: string }>(
      `update connector_credentials
          set revoked_at = coalesce(revoked_at, now())
        where id = $1 and owner_user_id = $2
      returning id`,
      [
        requireValue(input.credentialId, 'credentialId'),
        requireValue(input.userId, 'userId')
      ]
    );

    return result.rows.length > 0;
  }
}
