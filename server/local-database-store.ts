import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

interface StoredGitHubOAuthToken {
  accessToken: string;
  createdAt: string;
  login?: string;
  scope?: string;
  tokenType?: string;
}

interface GitHubOAuthTokenRow {
  created_at: Date;
  encrypted_access_token: string;
  iv: string;
  login: string | null;
  scope: string | null;
  tag: string;
  token_type: string | null;
}

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

function databaseUrl() {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '';
}

export function isDatabaseConfigured() {
  return Boolean(databaseUrl());
}

function getPool() {
  const url = databaseUrl();

  if (!url) {
    return null;
  }

  pool ??= new pg.Pool({
    connectionString: url,
    max: 4
  });

  return pool;
}

function encryptionKey() {
  const source =
    process.env.PROJECT_SPACE_TOKEN_ENCRYPTION_KEY ??
    process.env.CLERK_SECRET_KEY ??
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN ??
    databaseUrl();

  return createHash('sha256').update(source).digest();
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function decrypt(row: Pick<GitHubOAuthTokenRow, 'encrypted_access_token' | 'iv' | 'tag'>) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(row.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(row.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_access_token, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function ensureSchema() {
  const client = getPool();

  if (!client) {
    return;
  }

  schemaReady ??= client.query(`
    create table if not exists github_oauth_tokens (
      user_id text primary key,
      login text,
      encrypted_access_token text not null,
      iv text not null,
      tag text not null,
      scope text,
      token_type text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `).then(() => undefined);

  await schemaReady;
}

export async function readGitHubOAuthToken(
  userId: string
): Promise<StoredGitHubOAuthToken | null> {
  const client = getPool();

  if (!client) {
    return null;
  }

  await ensureSchema();

  const result = await client.query<GitHubOAuthTokenRow>(
    `select login, encrypted_access_token, iv, tag, scope, token_type, created_at
       from github_oauth_tokens
      where user_id = $1`,
    [userId]
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    accessToken: decrypt(row),
    createdAt: row.created_at.toISOString(),
    login: row.login ?? undefined,
    scope: row.scope ?? undefined,
    tokenType: row.token_type ?? undefined
  };
}

export async function writeGitHubOAuthToken(
  userId: string,
  token: StoredGitHubOAuthToken
) {
  const client = getPool();

  if (!client) {
    throw new Error('DATABASE_URL is required to persist GitHub login for this account.');
  }

  await ensureSchema();

  const encrypted = encrypt(token.accessToken);

  await client.query(
    `insert into github_oauth_tokens (
        user_id, login, encrypted_access_token, iv, tag, scope, token_type, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now(), now())
      on conflict (user_id) do update set
        login = excluded.login,
        encrypted_access_token = excluded.encrypted_access_token,
        iv = excluded.iv,
        tag = excluded.tag,
        scope = excluded.scope,
        token_type = excluded.token_type,
        updated_at = now()`,
    [
      userId,
      token.login ?? null,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag,
      token.scope ?? null,
      token.tokenType ?? null
    ]
  );
}
