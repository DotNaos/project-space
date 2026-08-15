import pg from 'pg';

import type { DatabaseQueryClient } from './database/client';
import { runDatabaseMigrations } from './database/migrations';
import {
  GitHubOAuthTokenStore,
  type StoredGitHubOAuthToken
} from './github-oauth-token-store';
import type { TransactionalDatabaseQueryClient } from './machine-connection-database-store';
import { projectSpaceLogger } from './observability';
import { PostgresProjectChatRepository } from './project-chat/postgres-store';
import { PostgresRoadmapPlanStore, type RoadmapPlanStore } from './roadmap/roadmap-store';
import type {
  CreateDevServerSessionInput,
  DevServerSessionKey,
  DevServerSessionListFilter,
  MachineMembershipKey,
  MachineExecutionScopeKey,
  PhysicalMachineKey,
  ProjectRunSettingsKey,
  SavePhysicalMachineInput,
  SaveMachineExecutionScopeInput,
  TransitionDevServerSessionInput,
  UpsertUserProjectsStateInput,
  UpsertProjectRunSettingsInput
} from './database/models';
import { ProjectSpaceDatabaseRepository } from './database/repository';
import { PostgresPrivateNetworkStore, type PrivateNetworkStore } from './private-network/store';
import {
  PostgresTailscaleInventoryStore
} from './tailscale-inventory/store';
import {
  createProviderCredentialVault,
  ProviderCredentialVaultError
} from './tailscale-provider-connection/credential-vault';
import {
  PostgresTailscaleProviderConnectionStore
} from './tailscale-provider-connection/store';

export type {
  CreateDevServerSessionInput,
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
  PhysicalMachineKey,
  SavePhysicalMachineInput,
  SaveMachineExecutionScopeInput,
  TransitionDevServerSessionInput,
  UpsertUserProjectsStateInput,
  UpsertProjectRunSettingsInput
} from './database/models';

let pool: pg.Pool | null = null;
let repository: ProjectSpaceDatabaseRepository | null = null;
let projectChatRepository: PostgresProjectChatRepository | null = null;
let roadmapPlanStore: RoadmapPlanStore | null = null;
let privateNetworkStore: PrivateNetworkStore | null = null;
let tailscaleInventoryStore: PostgresTailscaleInventoryStore | null = null;
let tailscaleProviderConnectionStore: PostgresTailscaleProviderConnectionStore | null = null;
let schemaReady: Promise<void> | null = null;
const githubOAuthReconnectRequired = new Set<string>();

function databaseUrl() {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '';
}

export function isDatabaseConfigured() {
  return Boolean(databaseUrl());
}

export function isGitHubOAuthReconnectRequired(userId: string) {
  return githubOAuthReconnectRequired.has(userId);
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

async function invalidateGitHubCatalogCache(client: pg.Pool, userId: string) {
  await client.query(`delete from github_catalog_cache where user_id = $1`, [userId]);
}

function githubOAuthTokenStore(client: pg.Pool) {
  return new GitHubOAuthTokenStore({
    client: createQueryClient(client),
    databaseUrl: databaseUrl()
  });
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

export async function getTailscaleInventoryStore() {
  const databasePool = getPool();
  if (!databasePool) return null;
  await ensureDatabaseSchema();
  tailscaleInventoryStore ??= new PostgresTailscaleInventoryStore(
    createPoolQueryClient(databasePool)
  );
  return tailscaleInventoryStore;
}

export async function getTailscaleProviderConnectionStore() {
  const databasePool = getPool();
  if (!databasePool) return null;
  await ensureDatabaseSchema();
  if (!tailscaleProviderConnectionStore) {
    let vault: ReturnType<typeof createProviderCredentialVault> | {
      decrypt(): never; encrypt(): never;
    };
    try {
      vault = createProviderCredentialVault(process.env);
    } catch {
      vault = {
        decrypt() { throw new ProviderCredentialVaultError(); },
        encrypt() { throw new ProviderCredentialVaultError(); }
      };
    }
    tailscaleProviderConnectionStore = new PostgresTailscaleProviderConnectionStore(
      createPoolQueryClient(databasePool), vault
    );
  }
  return tailscaleProviderConnectionStore;
}

export async function readGitHubOAuthToken(
  userId: string
): Promise<StoredGitHubOAuthToken | null> {
  const client = getPool();

  if (!client) {
    return null;
  }

  await ensureDatabaseSchema();
  const result = await githubOAuthTokenStore(client).read(userId);

  if (result.status === 'missing') {
    githubOAuthReconnectRequired.delete(userId);
    return null;
  }
  if (result.status === 'reconnect-required') {
    try {
      await invalidateGitHubCatalogCache(client, userId);
    } catch {
      projectSpaceLogger.warn('github.oauth.token.cache_invalidation_failed');
    }
    githubOAuthReconnectRequired.add(userId);
    projectSpaceLogger.warn('github.oauth.token.unreadable', {
      action: 'reconnect-required'
    });
    return null;
  }

  githubOAuthReconnectRequired.delete(userId);
  return result.token;
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
  await githubOAuthTokenStore(client).write(userId, token);
  githubOAuthReconnectRequired.delete(userId);
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
