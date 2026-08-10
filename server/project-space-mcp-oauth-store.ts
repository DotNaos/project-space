import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

import type { DatabaseQueryClient } from './database/client';
import {
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured
} from './local-database-store';

export const projectSpaceMcpReadScope = 'project-space:read';
export const projectSpaceMcpWriteScope = 'project-space:write';
export const projectSpaceMcpEnvironmentManageScope =
  'project-space:environment.manage';
export const projectSpaceMcpEnvironmentDeleteScope =
  'project-space:environment.delete';
export const projectSpaceMcpAgentAuthorizeScope =
  'project-space:agent.authorize';
export const projectSpaceMcpExecutionWriteScope =
  'project-space:execution.write';
export const projectSpaceMcpExecutionApproveScope =
  'project-space:execution.approve';
export const projectSpaceMcpTaskWriteScope =
  'project-space:task.write';
export const projectSpaceMcpDefaultScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope
] as const;
export const projectSpaceMcpSupportedScopes = [
  ...projectSpaceMcpDefaultScopes,
  projectSpaceMcpAgentAuthorizeScope,
  projectSpaceMcpExecutionApproveScope,
  projectSpaceMcpExecutionWriteScope,
  projectSpaceMcpTaskWriteScope,
  projectSpaceMcpEnvironmentManageScope,
  projectSpaceMcpEnvironmentDeleteScope
] as const;

/** @deprecated Prefer the explicit default or supported scope collection. */
export const projectSpaceMcpScopes = projectSpaceMcpSupportedScopes;

const authorizationLifetimeMs = 10 * 60_000;
const accessTokenLifetimeMs = 60 * 60_000;
const refreshTokenLifetimeMs = 30 * 24 * 60 * 60_000;

export interface PendingMcpAuthorization {
  clientId: string;
  codeChallenge: string;
  expiresAt: number;
  id: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state?: string;
}

export interface StoredMcpCredential {
  clientId: string;
  codeChallenge?: string;
  consumedAt?: number;
  expiresAt: number;
  kind: 'authorization_code' | 'access_token' | 'refresh_token';
  redirectUri?: string;
  resource: string;
  revokedAt?: number;
  scopes: string[];
  userEmail?: string;
  userId: string;
}

export interface ProjectSpaceMcpOAuthStore {
  consumeAuthorization(id: string): Promise<PendingMcpAuthorization | undefined>;
  consumeCredential(token: string, kind: StoredMcpCredential['kind'], clientId: string): Promise<StoredMcpCredential | undefined>;
  createAuthorization(input: Omit<PendingMcpAuthorization, 'expiresAt' | 'id'>): Promise<PendingMcpAuthorization>;
  createCredential(input: Omit<StoredMcpCredential, 'expiresAt' | 'kind'> & { kind: StoredMcpCredential['kind'] }): Promise<string>;
  deleteAuthorization(id: string): Promise<void>;
  getAuthorization(id: string): Promise<PendingMcpAuthorization | undefined>;
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  getCredential(token: string, kind: StoredMcpCredential['kind']): Promise<StoredMcpCredential | undefined>;
  registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull>;
  revokeCredential(token: string): Promise<void>;
}

function tokenLifetime(kind: StoredMcpCredential['kind']) {
  if (kind === 'access_token') return accessTokenLifetimeMs;
  if (kind === 'refresh_token') return refreshTokenLifetimeMs;
  return authorizationLifetimeMs;
}

function tokenPrefix(kind: StoredMcpCredential['kind']) {
  if (kind === 'access_token') return 'psat_';
  if (kind === 'refresh_token') return 'psrt_';
  return 'psac_';
}

function createOpaqueToken(kind: StoredMcpCredential['kind']) {
  return `${tokenPrefix(kind)}${randomBytes(32).toString('base64url')}`;
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export class MemoryProjectSpaceMcpOAuthStore implements ProjectSpaceMcpOAuthStore {
  private readonly authorizations = new Map<string, PendingMcpAuthorization>();
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly credentials = new Map<string, StoredMcpCredential>();

  async getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  async registerClient(client: OAuthClientInformationFull) {
    this.clients.set(client.client_id, structuredClone(client));
    return client;
  }

  async createAuthorization(input: Omit<PendingMcpAuthorization, 'expiresAt' | 'id'>) {
    const authorization = {
      ...input,
      expiresAt: Date.now() + authorizationLifetimeMs,
      id: randomUUID()
    };
    this.authorizations.set(authorization.id, authorization);
    return authorization;
  }

  async getAuthorization(id: string) {
    const authorization = this.authorizations.get(id);
    if (!authorization || authorization.expiresAt <= Date.now()) return undefined;
    return authorization;
  }

  async consumeAuthorization(id: string) {
    const authorization = await this.getAuthorization(id);
    if (authorization) this.authorizations.delete(id);
    return authorization;
  }

  async deleteAuthorization(id: string) {
    this.authorizations.delete(id);
  }

  async createCredential(input: Omit<StoredMcpCredential, 'expiresAt' | 'kind'> & { kind: StoredMcpCredential['kind'] }) {
    const token = createOpaqueToken(input.kind);
    this.credentials.set(hashToken(token), {
      ...input,
      expiresAt: Date.now() + tokenLifetime(input.kind)
    });
    return token;
  }

  async getCredential(token: string, kind: StoredMcpCredential['kind']) {
    const credential = this.credentials.get(hashToken(token));
    if (!credential || credential.kind !== kind || credential.expiresAt <= Date.now() || credential.revokedAt || credential.consumedAt) return undefined;
    return credential;
  }

  async consumeCredential(token: string, kind: StoredMcpCredential['kind'], clientId: string) {
    const credential = await this.getCredential(token, kind);
    if (!credential || credential.clientId !== clientId) return undefined;
    credential.consumedAt = Date.now();
    return credential;
  }

  async revokeCredential(token: string) {
    const credential = this.credentials.get(hashToken(token));
    if (credential) credential.revokedAt = Date.now();
  }
}

interface AuthorizationRow {
  client_id: string;
  code_challenge: string;
  expires_at: Date;
  id: string;
  redirect_uri: string;
  resource: string;
  scopes: string[];
  state: string | null;
}

interface CredentialRow {
  client_id: string;
  code_challenge: string | null;
  consumed_at: Date | null;
  expires_at: Date;
  kind: StoredMcpCredential['kind'];
  redirect_uri: string | null;
  resource: string;
  revoked_at: Date | null;
  scopes: string[];
  user_email: string | null;
  user_id: string;
}

function authorizationFromRow(row: AuthorizationRow): PendingMcpAuthorization {
  return {
    clientId: row.client_id,
    codeChallenge: row.code_challenge,
    expiresAt: row.expires_at.getTime(),
    id: row.id,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    scopes: row.scopes,
    state: row.state ?? undefined
  };
}

function credentialFromRow(row: CredentialRow): StoredMcpCredential {
  return {
    clientId: row.client_id,
    codeChallenge: row.code_challenge ?? undefined,
    consumedAt: row.consumed_at?.getTime(),
    expiresAt: row.expires_at.getTime(),
    kind: row.kind,
    redirectUri: row.redirect_uri ?? undefined,
    resource: row.resource,
    revokedAt: row.revoked_at?.getTime(),
    scopes: row.scopes,
    userEmail: row.user_email ?? undefined,
    userId: row.user_id
  };
}

export class PostgresProjectSpaceMcpOAuthStore implements ProjectSpaceMcpOAuthStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async getClient(clientId: string) {
    const result = await this.client.query<{ metadata: OAuthClientInformationFull }>(
      `select metadata from project_space_mcp_oauth_clients where client_id = $1`,
      [clientId]
    );
    return result.rows[0]?.metadata;
  }

  async registerClient(client: OAuthClientInformationFull) {
    await this.client.query(
      `insert into project_space_mcp_oauth_clients (client_id, metadata)
       values ($1, $2::jsonb)
       on conflict (client_id) do update set metadata = excluded.metadata, updated_at = now()`,
      [client.client_id, JSON.stringify(client)]
    );
    return client;
  }

  async createAuthorization(input: Omit<PendingMcpAuthorization, 'expiresAt' | 'id'>) {
    const authorization = { ...input, expiresAt: Date.now() + authorizationLifetimeMs, id: randomUUID() };
    await this.client.query(
      `insert into project_space_mcp_oauth_authorizations
         (id, client_id, redirect_uri, state, code_challenge, scopes, resource, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))`,
      [authorization.id, authorization.clientId, authorization.redirectUri, authorization.state ?? null,
        authorization.codeChallenge, authorization.scopes, authorization.resource, authorization.expiresAt]
    );
    return authorization;
  }

  async getAuthorization(id: string) {
    const result = await this.client.query<AuthorizationRow>(
      `select id, client_id, redirect_uri, state, code_challenge, scopes, resource, expires_at
         from project_space_mcp_oauth_authorizations
        where id = $1 and expires_at > now()`,
      [id]
    );
    return result.rows[0] ? authorizationFromRow(result.rows[0]) : undefined;
  }

  async consumeAuthorization(id: string) {
    const result = await this.client.query<AuthorizationRow>(
      `delete from project_space_mcp_oauth_authorizations
        where id = $1 and expires_at > now()
      returning id, client_id, redirect_uri, state, code_challenge, scopes, resource, expires_at`,
      [id]
    );
    return result.rows[0] ? authorizationFromRow(result.rows[0]) : undefined;
  }

  async deleteAuthorization(id: string) {
    await this.client.query(`delete from project_space_mcp_oauth_authorizations where id = $1`, [id]);
  }

  async createCredential(input: Omit<StoredMcpCredential, 'expiresAt' | 'kind'> & { kind: StoredMcpCredential['kind'] }) {
    const token = createOpaqueToken(input.kind);
    const expiresAt = Date.now() + tokenLifetime(input.kind);
    await this.client.query(
      `insert into project_space_mcp_oauth_credentials
         (token_hash, kind, client_id, user_id, user_email, scopes, redirect_uri, code_challenge, resource, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))`,
      [hashToken(token), input.kind, input.clientId, input.userId, input.userEmail ?? null, input.scopes,
        input.redirectUri ?? null, input.codeChallenge ?? null, input.resource, expiresAt]
    );
    return token;
  }

  async getCredential(token: string, kind: StoredMcpCredential['kind']) {
    const result = await this.client.query<CredentialRow>(
      `select client_id, code_challenge, consumed_at, expires_at, kind, redirect_uri, resource,
              revoked_at, scopes, user_email, user_id
         from project_space_mcp_oauth_credentials
        where token_hash = $1 and kind = $2 and expires_at > now()
          and consumed_at is null and revoked_at is null`,
      [hashToken(token), kind]
    );
    return result.rows[0] ? credentialFromRow(result.rows[0]) : undefined;
  }

  async consumeCredential(token: string, kind: StoredMcpCredential['kind'], clientId: string) {
    const operation = async (client: DatabaseQueryClient) => {
      const result = await client.query<CredentialRow>(
        `update project_space_mcp_oauth_credentials
            set consumed_at = now()
          where token_hash = $1 and kind = $2 and client_id = $3 and expires_at > now()
            and consumed_at is null and revoked_at is null
        returning client_id, code_challenge, consumed_at, expires_at, kind, redirect_uri, resource,
                  revoked_at, scopes, user_email, user_id`,
        [hashToken(token), kind, clientId]
      );
      return result.rows[0] ? credentialFromRow(result.rows[0]) : undefined;
    };
    return this.client.transaction ? this.client.transaction(operation) : operation(this.client);
  }

  async revokeCredential(token: string) {
    await this.client.query(
      `update project_space_mcp_oauth_credentials set revoked_at = coalesce(revoked_at, now()) where token_hash = $1`,
      [hashToken(token)]
    );
  }
}

const memoryStore = new MemoryProjectSpaceMcpOAuthStore();
let postgresStore: Promise<ProjectSpaceMcpOAuthStore> | undefined;

export function getProjectSpaceMcpOAuthStore() {
  if (!isDatabaseConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      return Promise.reject(new Error('DATABASE_URL is required for the production MCP OAuth server.'));
    }
    return Promise.resolve(memoryStore);
  }
  postgresStore ??= getMachineConnectionDatabaseClient()
    .then((client) => new PostgresProjectSpaceMcpOAuthStore(client))
    .catch((error) => {
      postgresStore = undefined;
      throw error;
    });
  return postgresStore;
}
