import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { describe, expect, test } from 'bun:test';
import pg from 'pg';

import { createConfiguredCodexMachineTasksRuntime } from '../server/codex-machine-tasks/configured-runtime';
import { createCodexMachineTasksHttpApi } from '../server/codex-machine-tasks/http';
import type { DatabaseQueryClient } from '../server/database/client';
import { runDatabaseMigrations } from '../server/database/migrations';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';
import { PostgresTailscaleInventoryStore } from '../server/tailscale-inventory/store';
import type { CodexSessionsRuntime } from '../server/codex-sessions/runtime';
import type { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../src/shared/workspace-runtime-codex-api';
import { memoryStore } from './fixtures/codex-machine-tasks-service';

const databaseUrl = process.env.PROJECT_SPACE_TEST_DATABASE_URL ?? '';
const postgresTest = databaseUrl ? test : test.skip;
const userId = 'user-owner';
const deploymentOwnerId = 'project-space:tailscale-deployment';
const environmentId = '1cbcf4d5-985d-4216-8782-6107cb36562f';
const hostId = '24000000-0000-4000-8000-000000000002';
const secondHostId = '24000000-0000-4000-8000-000000000003';
const connectorId = '24000000-0000-4000-8000-000000000010';
const secondConnectorId = '24000000-0000-4000-8000-000000000011';
const deviceId = 'device-842';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const branch = '842-preserve-environment-ownership';
const commit = 'a'.repeat(40);
const taskThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const reportingThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399d';

interface DatabaseHarness {
  client: DatabaseQueryClient;
  pool: pg.Pool;
  admin: pg.Pool;
  repository: ProjectSpaceDatabaseRepository;
  inventory: PostgresTailscaleInventoryStore;
  schema: string;
}

function assertLoopbackDatabase(value: string) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('PROJECT_SPACE_TEST_DATABASE_URL must point to loopback PostgreSQL.');
  }
}

function databaseClient(pool: pg.Pool): DatabaseQueryClient {
  return {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      const result = await pool.query(sql, [...values]);
      return { rowCount: result.rowCount, rows: result.rows as Row[] };
    },
    async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
      const connection = await pool.connect();
      const client: DatabaseQueryClient = {
        async query<Row>(sql: string, values: readonly unknown[] = []) {
          const result = await connection.query(sql, [...values]);
          return { rowCount: result.rowCount, rows: result.rows as Row[] };
        }
      };
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

async function createDatabase(): Promise<DatabaseHarness> {
  assertLoopbackDatabase(databaseUrl);
  const schema = `tailscale_ownership_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`create schema "${schema}"`);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
  const client = databaseClient(pool);
  await runDatabaseMigrations(client);
  return {
    admin, client, inventory: new PostgresTailscaleInventoryStore(client),
    pool, repository: new ProjectSpaceDatabaseRepository(client), schema
  };
}

async function closeDatabase(database: DatabaseHarness) {
  await database.pool.end();
  await database.admin.query(`drop schema if exists "${database.schema}" cascade`);
  await database.admin.end();
}

function accountScopedIdentity(owner: string, value: string) {
  return `account:${createHash('sha256').update(owner).update('\0').update(value).digest('hex')}`;
}

function snapshot(freshUntil: string, observedAt = '2026-08-20T23:00:00.000Z') {
  return {
    backendState: 'running' as const,
    deviceErrors: [],
    devices: [{
      addresses: ['100.64.0.10'], id: deviceId, observedName: 'os-macbook.tail1234.ts.net',
      online: true, os: 'darwin', tags: []
    }],
    freshness: {
      freshUntil, observedAt, state: 'fresh' as const
    },
    source: 'tailscale_status_json' as const
  };
}

async function seedCandidate(
  database: DatabaseHarness,
  ownerUserId: string,
  machineId: string,
  physicalMachineId: string | null
) {
  await database.client.transaction?.(async (client) => {
    await client.query(
      `insert into machine_identities (
         id, owner_user_id, public_key, name, hostname, operating_system,
         architecture, client_version, created_at
       ) values ($1, $2, $3, 'os-macbook', 'os-macbook.example.test', 'darwin', 'arm64', '0.1.0', now())`,
      [machineId, ownerUserId, `A${machineId.replaceAll('-', '')}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`.slice(0, 43)]
    );
    await client.query(
      `insert into machine_memberships (id, machine_id, user_id, role)
       values ($1, $2, $3, 'owner')`,
      [randomUUID(), machineId, ownerUserId]
    );
  });
  if (physicalMachineId) {
    await database.repository.savePhysicalMachine({
      connectorIds: [machineId], name: `os-macbook-${physicalMachineId.slice(-1)}`,
      physicalMachineId, userId: ownerUserId
    });
  }
  const definition = await database.client.query<{ id: string }>(
    `select id from compute_environment_definitions
      where owner_user_id = $1 and slug = 'macos'`, [ownerUserId]
  );
  const platform = await database.client.query<{ id: string }>(
    `select id from compute_platforms
      where owner_user_id = $1 and kind = 'local' and name = 'Local & self-hosted'`, [ownerUserId]
  );
  if (!definition.rows[0] || !platform.rows[0]) throw new Error('Candidate bootstrap did not create local compute metadata.');
  await database.client.query(
    `update compute_environment_definitions
        set name = 'macOS', kind = 'native_macos', operating_system_family = 'macos',
            supported_architectures = '{}', bootstrap_strategy = 'ssh', ownership = 'built_in'
      where owner_user_id = $1 and id = $2`, [ownerUserId, definition.rows[0].id]
  );
  return { definitionId: definition.rows[0].id, platformId: platform.rows[0].id };
}

async function seedDeployment(database: DatabaseHarness, candidateOwner = userId, withHost = true) {
  const candidate = await seedCandidate(database, candidateOwner, connectorId, withHost ? hostId : null);
  const deploymentPlatform = await seedCandidate(database, deploymentOwnerId, '24000000-0000-4000-8000-000000000020', false);
  await database.client.query(
    `insert into compute_environments (
       id, owner_user_id, platform_id, environment_definition_id,
       identity_version, identity_key, kind, name, host_resolution, host_evidence,
       resource_mode, resources
     ) values ($1, $2, $3, $4, 1, $5, 'native_macos',
       'os-macbook.tail1234.ts.net', 'unresolved', 'none', 'dedicated', $6::jsonb)`,
    [environmentId, deploymentOwnerId, deploymentPlatform.platformId, deploymentPlatform.definitionId,
      accountScopedIdentity(deploymentOwnerId, `tailscale-environment:${deviceId}`), JSON.stringify({ cpu: 4, memoryMb: 8192 })]
  );
  await database.client.query(
    `insert into tailscale_device_observations (
       owner_user_id, device_id, observed_name, addresses, online, os, tags,
       observed_at, fresh_until, inventory_state
     ) values ($1, $2, 'os-macbook.tail1234.ts.net', ARRAY['100.64.0.10']::inet[], true,
       'darwin', '{}', '2026-08-20T23:00:00Z', '2026-08-21T00:00:00Z', 'current')`,
    [deploymentOwnerId, deviceId]
  );
  await database.client.query(
    `insert into tailscale_device_classifications
       (owner_user_id, device_id, classification, revision, actor_id)
     values ($1, $2, 'environment', 1, 'seed')`, [deploymentOwnerId, deviceId]
  );
  await database.client.query(
    `insert into tailscale_compute_environment_projections
       (owner_user_id, device_id, environment_id, classification_revision)
     values ($1, $2, $3, 1)`, [deploymentOwnerId, deviceId, environmentId]
  );
  return { candidate, deployment: deploymentPlatform };
}

function runtimeSessions(commands: WorkspaceRuntimeCodexCommand[]) {
  const listeners = new Set<(message: WorkspaceRuntimeCodexMessage) => Promise<void> | void>();
  const session = {
    branch, capabilities: ['runtime.codex.v1'], codexAcceptedCommandSequence: 0,
    commit, connectionState: 'online', devServers: [], environmentId,
    expiresAt: '2026-08-21T00:00:00.000Z', generation: '22222222-2222-4222-8222-222222222222',
    lastEventAt: '2026-08-20T18:00:00.000Z', lastHeartbeatAt: '2026-08-20T18:00:00.000Z',
    lastSequence: 1, lifecycleState: 'running', manifestDigest: 'b'.repeat(64),
    runtimeVersion: '0.4.66', schemaVersion: 1, sessionId: 'persisted-session-842', workspaceId
  };
  return {
    list: async (owner: string) => owner === userId ? [session] : [],
    onCodexMessage(listener: (message: WorkspaceRuntimeCodexMessage) => Promise<void> | void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatchCodex(_owner: string, command: WorkspaceRuntimeCodexCommand) {
      commands.push(command);
      const result = command.kind === 'start'
        ? { initialTurnId: 'turn-initial-842', machineId: command.request.machineId, threadId: taskThreadId }
        : { operationId: command.request.operationId, replayed: false, status: 'accepted' as const,
            threadId: command.request.threadId, turnId: 'turn-send-842' };
      queueMicrotask(() => {
        const message = { ...command, result, type: 'runtime.codex.result' } as unknown as WorkspaceRuntimeCodexMessage;
        for (const listener of listeners) void listener(message);
      });
    }
  } as unknown as WorkspaceRuntimeSessionService;
}

async function configuredHttp(database: DatabaseQueryClient) {
  const commands: WorkspaceRuntimeCodexCommand[] = [];
  const runtime = await createConfiguredCodexMachineTasksRuntime({
    backend: {
      async createGitHubBranch() { throw new Error('The integration path must not create a branch.'); },
      async getGitHubCatalog() {
        return { checkedAt: '', repositories: [{ defaultBranch: 'main', fullName: 'DotNaos/project-space', id: 42,
          isPrivate: true, name: 'project-space', owner: 'DotNaos', projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
          url: 'https://github.com/DotNaos/project-space' }], status: 'connected' as const };
      },
      async getGitHubRepositoryDetails() {
        return { branches: [{ commitSha: commit, isDefault: false, name: branch }], checkedAt: '',
          issues: [{ labels: [], number: 842, state: 'open' as const, title: 'Preserve Environment ownership', url: 'https://github.com/DotNaos/project-space/issues/842' }],
          pullRequests: [], status: 'connected' as const };
      }
    } as never,
    database, runtimeSessions: runtimeSessions(commands),
    sessionsRuntime: Promise.reject(new Error('Compatibility runtime is outside this path.')) as Promise<CodexSessionsRuntime>,
    taskStore: memoryStore(),
    workspaceBindingStore: {
      list: async () => [{ id: 'execution-842' }],
      readWorkspace: async () => ({ branch, commit, id: workspaceId, state: 'ready', target: { kind: 'project_worktree', reference: 'worktree-842' } })
    } as never
  });
  const api = createCodexMachineTasksHttpApi(runtime.service, async () => ({
    reportingTask: { role: 'project-manager', threadId: reportingThreadId }, userId
  }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await api(request, response, url)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing integration HTTP address.');
  return {
    commands, origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function mutation(operationId: string, body: Record<string, unknown>) {
  return { body: JSON.stringify({ ...body, operationId }), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId }, method: 'POST' };
}

async function withDatabase<Result>(operation: (database: DatabaseHarness) => Promise<Result>) {
  const database = await createDatabase();
  try {
    return await operation(database);
  } finally {
    await closeDatabase(database);
  }
}

describe('persisted configured Codex ownership PostgreSQL integration', () => {
  postgresTest('repairs stale startup evidence and retains exact Host and Environment through HTTP', async () => {
    await withDatabase(async (database) => {
      await seedDeployment(database);
      await database.client.query(
        `update tailscale_device_observations set observed_at = '2020-08-20T20:00:00Z', fresh_until = '2020-08-20T20:16:00Z'
          where owner_user_id = $1 and device_id = $2`, [deploymentOwnerId, deviceId]
      );
      const http = await configuredHttp(database.client);
      try {
        await database.inventory.reconcile(deploymentOwnerId, {
          complete: true, kind: 'snapshot', snapshot: snapshot('2020-08-20T23:30:00Z', '2020-08-20T23:00:00Z')
        });
        expect((await database.repository.listComputeInventory(userId)).environments.some(({ id }) => id === environmentId)).toBe(false);
        await database.inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z') });
        const repaired = await database.repository.listComputeInventory(userId);
        expect(repaired.environments.find(({ id }) => id === environmentId)).toMatchObject({
          environmentDefinitionId: expect.any(String), hostAssociation: { evidence: 'user', hostId, resolution: 'manual' },
          id: environmentId, identityResolution: 'resolved', kind: 'native_macos', name: 'os-macbook.tail1234.ts.net',
          platformId: expect.any(String), resourceMode: 'dedicated', resources: { cpu: 4, memoryMb: 8192 }
        });
        const persistedBefore = await database.client.query(
          `select id, owner_user_id, platform_id, host_id, environment_definition_id,
                  identity_version, identity_key, identity_resolution, kind, name,
                  host_resolution, host_evidence, resource_mode, resources
             from compute_environments where id = $1 and owner_user_id = $2`, [environmentId, userId]
        );
        await database.inventory.reconcile(deploymentOwnerId, {
          complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z')
        });
        const persistedAfter = await database.client.query(
          `select id, owner_user_id, platform_id, host_id, environment_definition_id,
                  identity_version, identity_key, identity_resolution, kind, name,
                  host_resolution, host_evidence, resource_mode, resources
             from compute_environments where id = $1 and owner_user_id = $2`, [environmentId, userId]
        );
        expect(persistedAfter.rows).toEqual(persistedBefore.rows);
        const start = await fetch(`${http.origin}/api/codex/tasks/start`, mutation('postgres-start-842', {
          expectedBranch: branch, expectedCommit: commit, issue: 842, physicalMachineId: hostId, repositoryId: 'DotNaos/project-space'
        }));
        const started = await start.json() as { state: string; task?: { threadId?: string } };
        expect(start.status).toBe(200);
        expect(started).toMatchObject({ state: 'confirmed', task: { physicalMachine: { id: hostId } } });
        const read = await fetch(`${http.origin}/api/codex/tasks/${started.task?.threadId}?physicalMachineId=${hostId}`);
        expect(await read.json()).toMatchObject({ state: 'confirmed', target: { physicalMachine: { id: hostId } } });
        const send = await fetch(`${http.origin}/api/codex/tasks/${started.task?.threadId}/send`, mutation('postgres-send-842', {
          delivery: 'new-turn', message: 'Continue through persisted ownership.', physicalMachineId: hostId
        }));
        expect(send.status).toBe(200);
        expect(await send.json()).toMatchObject({ state: 'accepted', target: { physicalMachine: { id: hostId } } });
        expect(http.commands.map(({ kind, environmentId: selected }) => ({ kind, selected }))).toEqual([
          { kind: 'start', selected: environmentId }, { kind: 'read', selected: environmentId }, { kind: 'continue', selected: environmentId }
        ]);
      } finally {
        await http.close();
      }
    });
  });

  postgresTest('repairs when Host membership is added after startup', async () => {
    await withDatabase(async (database) => {
      await seedDeployment(database, userId, false);
      await database.inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z') });
      expect((await database.repository.listComputeInventory(userId)).environments.some(({ id }) => id === environmentId)).toBe(false);
      await database.repository.savePhysicalMachine({ connectorIds: [connectorId], name: 'os-macbook', physicalMachineId: hostId, userId });
      expect((await database.repository.listComputeInventory(userId)).environments.find(({ id }) => id === environmentId)).toMatchObject({
        hostAssociation: { evidence: 'user', hostId, resolution: 'manual' }
      });
    });
  });

  postgresTest('keeps one stable user copy across environment to unclassified to environment', async () => {
    await withDatabase(async (database) => {
      await seedDeployment(database);
      await database.inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z') });
      await database.inventory.setClassification({ actorId: 'manager', classification: 'unclassified', deviceId, expectedRevision: 1, ownerUserId: deploymentOwnerId });
      await database.inventory.setClassification({ actorId: 'manager', classification: 'environment', deviceId, expectedRevision: 2, ownerUserId: deploymentOwnerId });
      const projection = await database.client.query<{ environment_id: string }>(
        `select environment_id from tailscale_compute_environment_projections where owner_user_id = $1 and device_id = $2`, [deploymentOwnerId, deviceId]
      );
      const rows = await database.client.query<{ id: string; owner_user_id: string; host_resolution: string; host_evidence: string }>(
        `select id, owner_user_id, host_resolution, host_evidence from compute_environments where id = $1 order by owner_user_id`, [environmentId]
      );
      expect(projection.rows[0]?.environment_id).toBe(environmentId);
      expect(rows.rows).toEqual([
        { id: environmentId, owner_user_id: deploymentOwnerId, host_resolution: 'unresolved', host_evidence: 'none' },
        { id: environmentId, owner_user_id: userId, host_resolution: 'manual', host_evidence: 'user' }
      ]);
    });
  });

  postgresTest('does not overwrite a user-defined same-UUID Environment', async () => {
    await withDatabase(async (database) => {
      await seedDeployment(database);
      await database.inventory.reconcile(deploymentOwnerId, {
        complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z')
      });
      await database.client.query(
        `update compute_environment_definitions definition
            set ownership = 'user_defined', name = 'User evidence'
          from compute_environments environment
         where environment.owner_user_id = $1
           and environment.id = $2
           and definition.owner_user_id = environment.owner_user_id
           and definition.id = environment.environment_definition_id`, [userId, environmentId]
      );
      await database.inventory.reconcile(deploymentOwnerId, {
        complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z')
      });
      const preserved = await database.client.query<{ name: string; ownership: string; host_id: string }>(
        `select definition.name, definition.ownership, environment.host_id
           from compute_environments environment
           join compute_environment_definitions definition
             on definition.owner_user_id = environment.owner_user_id
            and definition.id = environment.environment_definition_id
          where environment.owner_user_id = $1 and environment.id = $2`, [userId, environmentId]
      );
      expect(preserved.rows).toEqual([{ name: 'User evidence', ownership: 'user_defined', host_id: hostId }]);
    });
  });

  postgresTest('fails closed for wrong-owner and ambiguous candidates', async () => {
    await withDatabase(async (database) => {
      await seedDeployment(database, deploymentOwnerId);
      await database.inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z') });
      expect((await database.repository.listComputeInventory(userId)).environments.some(({ id }) => id === environmentId)).toBe(false);
      await database.repository.savePhysicalMachine({ connectorIds: [connectorId], name: 'os-macbook', physicalMachineId: hostId, userId: deploymentOwnerId });

      const ambiguous = await createDatabase();
      try {
        await seedDeployment(ambiguous);
        await seedCandidate(ambiguous, userId, secondConnectorId, secondHostId);
        await ambiguous.inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z') });
        expect((await ambiguous.repository.listComputeInventory(userId)).environments.some(({ id }) => id === environmentId)).toBe(false);
      } finally {
        await closeDatabase(ambiguous);
      }
    });
  });

  postgresTest('serializes concurrent refresh and Host membership without conflicting copies', async () => {
    await withDatabase(async (database) => {
      await seedDeployment(database, userId, false);
      const fresh = database.inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot: snapshot('2026-08-21T00:00:00Z') });
      const membership = database.repository.savePhysicalMachine({ connectorIds: [connectorId], name: 'os-macbook', physicalMachineId: hostId, userId });
      await Promise.all([fresh, membership]);
      const rows = await database.client.query<{ owner_user_id: string; id: string }>(
        `select owner_user_id, id from compute_environments where id = $1`, [environmentId]
      );
      expect(rows.rows.filter(({ owner_user_id }) => owner_user_id === userId)).toHaveLength(1);
      expect((await database.repository.listComputeInventory(userId)).environments.find(({ id }) => id === environmentId)).toMatchObject({
        hostAssociation: { hostId, resolution: 'manual' }
      });
    });
  });
});
