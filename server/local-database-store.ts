import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

import type { DatabaseQueryClient } from './database/client';
import { runDatabaseMigrations } from './database/migrations';
import type { TransactionalDatabaseQueryClient } from './machine-connection-database-store';
import { PostgresProjectChatRepository } from './project-chat/postgres-store';
import { PostgresRoadmapPlanStore, type RoadmapPlanStore } from './roadmap/roadmap-store';
import { ConnectorMachineSnapshotStore } from './connector-machine-snapshot-store';
import { PostgresConnectorRuntimeOperationStore } from './connector-runtime-operation-store';
import type {
  AuthenticateConnectorCredentialInput,
  CreateDevServerSessionInput,
  CreateConnectorCredentialInput,
  DevServerSessionKey,
  DevServerSessionListFilter,
  MachineMembershipKey,
  MachineExecutionScopeKey,
  PhysicalMachineKey,
  ProjectRunSettingsKey,
  RevokeConnectorCredentialInput,
  SavePhysicalMachineInput,
  SaveMachineExecutionScopeInput,
  TransitionDevServerSessionInput,
  UpsertUserProjectsStateInput,
  UpsertProjectRunSettingsInput
} from './database/models';
import { ProjectSpaceDatabaseRepository } from './database/repository';
import { PostgresPrivateNetworkStore, type PrivateNetworkStore } from './private-network/store';

export type {
  AuthenticateConnectorCredentialInput,
  AuthenticatedConnectorCredential,
  CreateDevServerSessionInput,
  CreateConnectorCredentialInput,
  CreatedConnectorCredential,
  DevServerSession,
  DevServerSessionKey,
  DevServerSessionListFilter,
  DevServerSessionState,
  MachineMembership,
  MachineExecutionScopeKey,
  MachineMembershipKey,
  MachineMembershipRole,
  ProjectRunSettings,
  ProjectRunSettingsKey,
  RevokeConnectorCredentialInput,
  PhysicalMachineKey,
  SavePhysicalMachineInput,
  SaveMachineExecutionScopeInput,
  StoredConnectorCredential,
  TransitionDevServerSessionInput,
  UpsertUserProjectsStateInput,
  UpsertProjectRunSettingsInput
} from './database/models';

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
let repository: ProjectSpaceDatabaseRepository | null = null;
let projectChatRepository: PostgresProjectChatRepository | null = null;
let connectorMachineSnapshotStore: ConnectorMachineSnapshotStore | null = null;
let connectorRuntimeOperationStore: PostgresConnectorRuntimeOperationStore | null = null;
let roadmapPlanStore: RoadmapPlanStore | null = null;
let privateNetworkStore: PrivateNetworkStore | null = null;
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

function createQueryClient(queryable: pg.Pool | pg.PoolClient): DatabaseQueryClient {
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await queryable.query(sql, values ? [...values] : undefined);

      return {
        rowCount: result.rowCount,
        rows: result.rows as Row[]
      };
    }
  };
}

function createPoolQueryClient(
  databasePool: pg.Pool
): TransactionalDatabaseQueryClient {
  return {
    ...createQueryClient(databasePool),
    async transaction<Result>(
      operation: (client: DatabaseQueryClient) => Promise<Result>
    ) {
      const connection = await databasePool.connect();
      const client = createQueryClient(connection);

      try {
        await client.query('begin');
        const result = await operation(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
    }
  };
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

async function migrateDatabase() {
  const databasePool = getPool();

  if (!databasePool) {
    return;
  }

  const connection = await databasePool.connect();

  try {
    await runDatabaseMigrations(createQueryClient(connection));
  } finally {
    connection.release();
  }
}

export async function ensureDatabaseSchema() {
  schemaReady ??= migrateDatabase().catch((error) => {
    schemaReady = null;
    throw error;
  });

  await schemaReady;
}

async function getDatabaseRepository() {
  const databasePool = getPool();

  if (!databasePool) {
    throw new Error('DATABASE_URL is required to use multi-user Project Space data.');
  }

  await ensureDatabaseSchema();
  repository ??= new ProjectSpaceDatabaseRepository(createPoolQueryClient(databasePool));

  return repository;
}

export async function getProjectChatRepository() {
  const databasePool = getPool();

  if (!databasePool) {
    throw new Error('DATABASE_URL is required to persist Project Chat messages.');
  }

  await ensureDatabaseSchema();
  projectChatRepository ??= new PostgresProjectChatRepository(
    createPoolQueryClient(databasePool)
  );

  return projectChatRepository;
}

export async function getMachineConnectionDatabaseClient(): Promise<
  TransactionalDatabaseQueryClient
> {
  const databasePool = getPool();

  if (!databasePool) {
    throw new Error('DATABASE_URL is required to connect machines.');
  }

  await ensureDatabaseSchema();

  return createPoolQueryClient(databasePool);
}

export async function getCodexSessionsDatabaseClient(): Promise<
  TransactionalDatabaseQueryClient
> {
  return getMachineConnectionDatabaseClient();
}

export async function getRoadmapPlanStore() {
  const databasePool = getPool();
  if (!databasePool) return null;
  await ensureDatabaseSchema();
  roadmapPlanStore ??= new PostgresRoadmapPlanStore(createPoolQueryClient(databasePool));
  return roadmapPlanStore;
}

export async function getPrivateNetworkStore() {
  const databasePool = getPool();
  if (!databasePool) return null;
  await ensureDatabaseSchema();
  privateNetworkStore ??= new PostgresPrivateNetworkStore(createPoolQueryClient(databasePool));
  return privateNetworkStore;
}

export async function getConnectorMachineSnapshotStore() {
  const databasePool = getPool();
  if (!databasePool) {
    return null;
  }
  await ensureDatabaseSchema();
  connectorMachineSnapshotStore ??= new ConnectorMachineSnapshotStore(
    createPoolQueryClient(databasePool)
  );
  return connectorMachineSnapshotStore;
}

export async function getConnectorRuntimeOperationStore() {
  const databasePool = getPool();
  if (!databasePool) return null;
  await ensureDatabaseSchema();
  connectorRuntimeOperationStore ??= new PostgresConnectorRuntimeOperationStore(
    createPoolQueryClient(databasePool)
  );
  return connectorRuntimeOperationStore;
}

export async function readGitHubOAuthToken(
  userId: string
): Promise<StoredGitHubOAuthToken | null> {
  const client = getPool();

  if (!client) {
    return null;
  }

  await ensureDatabaseSchema();

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

  await ensureDatabaseSchema();

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

export async function claimMachineMembership(input: MachineMembershipKey) {
  return (await getDatabaseRepository()).claimMachineMembership(input);
}

export async function hasMachineMembership(input: MachineMembershipKey) {
  return (await getDatabaseRepository()).hasMachineMembership(input);
}

export async function isMachineClaimed(machineId: string) {
  return (await getDatabaseRepository()).isMachineClaimed(machineId);
}

export async function readMachineMembership(input: MachineMembershipKey) {
  return (await getDatabaseRepository()).readMachineMembership(input);
}

export async function listMachineMemberships(userId: string) {
  return (await getDatabaseRepository()).listMachineMemberships(userId);
}

export async function readProjectRunSettings(input: ProjectRunSettingsKey) {
  return (await getDatabaseRepository()).readProjectRunSettings(input);
}

export async function upsertProjectRunSettings(input: UpsertProjectRunSettingsInput) {
  return (await getDatabaseRepository()).upsertProjectRunSettings(input);
}

export async function deleteProjectRunSettings(input: ProjectRunSettingsKey) {
  return (await getDatabaseRepository()).deleteProjectRunSettings(input);
}

export async function readUserProjectsState(userId: string) {
  return (await getDatabaseRepository()).readUserProjectsState(userId);
}

export async function upsertUserProjectsState(input: UpsertUserProjectsStateInput) {
  return (await getDatabaseRepository()).upsertUserProjectsState(input);
}

export async function createDevServerSession(input: CreateDevServerSessionInput) {
  return (await getDatabaseRepository()).createDevServerSession(input);
}

export async function readDevServerSession(input: DevServerSessionKey) {
  return (await getDatabaseRepository()).readDevServerSession(input);
}

export async function listDevServerSessions(
  userId: string,
  filter?: DevServerSessionListFilter
) {
  return (await getDatabaseRepository()).listDevServerSessions(userId, filter);
}

export async function transitionDevServerSession(input: TransitionDevServerSessionInput) {
  return (await getDatabaseRepository()).transitionDevServerSession(input);
}

export async function deleteDevServerSession(input: DevServerSessionKey) {
  return (await getDatabaseRepository()).deleteDevServerSession(input);
}

export async function createConnectorCredential(input: CreateConnectorCredentialInput) {
  return (await getDatabaseRepository()).createConnectorCredential(input);
}

export async function authenticateConnectorCredential(
  input: AuthenticateConnectorCredentialInput
) {
  return (await getDatabaseRepository()).authenticateConnectorCredential(input);
}

export async function listConnectorCredentials(userId: string) {
  return (await getDatabaseRepository()).listConnectorCredentials(userId);
}

export async function revokeConnectorCredential(input: RevokeConnectorCredentialInput) {
  return (await getDatabaseRepository()).revokeConnectorCredential(input);
}

export async function listComputeInventory(userId: string) {
  return (await getDatabaseRepository()).listComputeInventory(userId);
}

export async function reconcileConnectorComputeInventory(
  userId: string,
  machines: readonly import('../src/shared/project-space-api').MachineRecord[]
) {
  return (await getDatabaseRepository()).reconcileConnectorComputeInventory(userId, machines);
}

export async function listPhysicalMachines(userId: string) {
  return (await getDatabaseRepository()).listPhysicalMachines(userId);
}

export async function savePhysicalMachine(input: SavePhysicalMachineInput) {
  return (await getDatabaseRepository()).savePhysicalMachine(input);
}

export async function deletePhysicalMachine(input: PhysicalMachineKey) {
  return (await getDatabaseRepository()).deletePhysicalMachine(input);
}

export async function listMachineExecutionScopes(userId: string) {
  return (await getDatabaseRepository()).listMachineExecutionScopes(userId);
}

export async function saveMachineExecutionScope(input: SaveMachineExecutionScopeInput) {
  return (await getDatabaseRepository()).saveMachineExecutionScope(input);
}

export async function deleteMachineExecutionScope(input: MachineExecutionScopeKey) {
  return (await getDatabaseRepository()).deleteMachineExecutionScope(input);
}
