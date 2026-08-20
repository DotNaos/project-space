import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { createConfiguredCodexMachineTasksRuntime } from '../server/codex-machine-tasks/configured-runtime';
import { createCodexMachineTasksHttpApi } from '../server/codex-machine-tasks/http';
import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';
import { PostgresTailscaleInventoryStore } from '../server/tailscale-inventory/store';
import type { CodexSessionsRuntime } from '../server/codex-sessions/runtime';
import type { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../src/shared/workspace-runtime-codex-api';
import { memoryStore } from './fixtures/codex-machine-tasks-service';

const userId = 'user-owner';
const deploymentOwnerId = 'project-space:tailscale-deployment';
const environmentId = '1cbcf4d5-985d-4216-8782-6107cb36562f';
const hostId = '24000000-0000-4000-8000-000000000002';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const branch = '842-preserve-environment-ownership';
const commit = 'a'.repeat(40);
const taskThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const reportingThreadId = '019f6d33-6aad-7302-a45e-bb7a33fc399d';
const visibleOwners = [userId, deploymentOwnerId];
const servers: Server[] = [];

type AssociationState =
  | 'verified'
  | 'missing'
  | 'unresolved'
  | 'conflict'
  | 'deployment-only'
  | 'ambiguous'
  | 'fresh-classification'
  | 'fresh-classification-ineligible';

interface PersistedRow extends Record<string, unknown> {
  owner_user_id?: string;
}

class PersistedCollisionDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly returnedDefinitionOwners: string[] = [];
  private observedDevice = false;
  private classification: 'unclassified' | 'environment' = 'unclassified';
  private projectedEnvironmentId: string | null = null;
  private observed = { inventoryState: 'current', online: false, observedAt: '', freshUntil: '', os: '', name: '' };
  private userRepair: PersistedRow | null = null;

  constructor(private readonly associationState: AssociationState) {
    if (this.isLifecycleProof()) {
      this.observed = {
        inventoryState: 'current', name: 'os-macbook.tail1234.ts.net', online: true, os: 'darwin',
        observedAt: '2026-08-20T23:00:00.000Z', freshUntil: associationState === 'fresh-classification'
          ? '2026-08-21T00:00:00.000Z' : '2026-08-20T20:00:00.000Z'
      };
    }
  }

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] as Row[] };
    if (sql.includes('with candidate_rows') && sql.includes('insert into compute_environments')) {
      this.reconcileLifecycle(sql);
      return { rows: [] as Row[] };
    }
    if (sql.includes('insert into tailscale_device_observations')) {
      this.observedDevice = true;
      if (this.isLifecycleProof()) {
        this.observed = {
          inventoryState: 'current', name: String(values[2]), online: Boolean(values[4]), os: String(values[5]),
          observedAt: String(values[7]), freshUntil: String(values[8])
        };
      }
      return { rows: [] as Row[] };
    }
    if (sql.includes('select device_id from tailscale_device_observations')) {
      return { rows: this.observedDevice ? [{ device_id: 'device-842' }] as Row[] : [] as Row[] };
    }
    if (sql.includes('select classification, revision from tailscale_device_classifications')) {
      return {
        rows: this.observedDevice
          ? [{ classification: this.classification, revision: this.classification === 'environment' ? 1 : 0 }] as Row[]
          : [] as Row[]
      };
    }
    if (sql.includes('insert into tailscale_device_classifications')) {
      this.classification = String(values[2]) as typeof this.classification;
      return { rows: [{ classification: this.classification, revision: 1 }] as Row[] };
    }
    if (sql.includes('select observed_name, os from tailscale_device_observations')) {
      return { rows: [{ observed_name: 'os-macbook.tail1234.ts.net', os: 'darwin' }] as Row[] };
    }
    if (sql.includes('insert into compute_platforms')) {
      return { rows: [{ id: 'platform-user' }] as Row[] };
    }
    if (sql.includes('insert into compute_environment_definitions')) {
      return { rows: [{ id: 'same-definition-id' }] as Row[] };
    }
    if (sql.includes('insert into compute_environments')) {
      if (this.isLifecycleProof()) {
        this.projectedEnvironmentId = environmentId;
      }
      return { rows: [{ id: environmentId }] as Row[] };
    }
    if (sql.includes('insert into tailscale_compute_environment_projections')) {
      if (this.isLifecycleProof()) this.projectedEnvironmentId = String(values[2]);
      return { rows: [] as Row[] };
    }
    if (sql.includes('insert into tailscale_device_classification_audits')) {
      return { rows: [] as Row[] };
    }
    if (sql.includes('from compute_environment_definitions') && sql.includes('order by lower')) {
      const rows = this.visible(this.isLifecycleProof() ? this.lifecycleDefinitions() : [
        definition(userId, 'a', 'built_in', 'macOS'),
        definition(deploymentOwnerId, 'x', 'built_in', 'macOS'),
        definition(userId, 'x', 'user_defined', 'User macOS')
      ]);
      this.returnedDefinitionOwners.push(...rows.map((row) => `${row.owner_user_id}:${row.id}`));
      return { rows: rows as Row[] };
    }
    if (sql.includes('from compute_platforms') && sql.includes('order by lower')) {
      return { rows: this.visible([
        { id: 'platform-user', kind: 'local', name: 'Local & self-hosted', owner_user_id: userId },
        { id: 'platform-deployment', kind: 'local', name: 'Deployment', owner_user_id: deploymentOwnerId }
      ]) as Row[] };
    }
    if (sql.includes('from compute_hosts') && sql.includes('order by lower')) {
      return { rows: this.visible(this.hostRows()) as Row[] };
    }
    if (sql.includes('from compute_environments') && sql.includes('order by lower')) {
      return { rows: this.visible(this.environmentRows()) as Row[] };
    }
    if (sql.includes('from connector_compute_environments') && sql.includes('order by connector_id')) {
      return { rows: [] as Row[] };
    }
    return { rows: [] as Row[] };
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }

  private visible(rows: PersistedRow[]) {
    const latest = this.calls.at(-1)?.values[0];
    const owners = Array.isArray(latest) ? latest : [userId];
    return rows.filter((row) => !row.owner_user_id || owners.includes(row.owner_user_id));
  }

  private hostRows(): PersistedRow[] {
    if (this.isLifecycleProof()) {
      return [
        host(userId, hostId, 'os-macbook'),
        host(deploymentOwnerId, '24000000-0000-4000-8000-000000000099', 'deployment-mac')
      ];
    }
    if (this.associationState === 'deployment-only') {
      return [host(deploymentOwnerId, hostId, 'deployment-os-macbook')];
    }
    if (this.associationState === 'ambiguous') {
      return [
        host(userId, hostId, 'os-macbook'),
        host(userId, hostId, 'duplicate-os-macbook'),
        host(deploymentOwnerId, hostId, 'deployment-os-macbook')
      ];
    }
    return [
      host(userId, hostId, 'os-macbook'),
      host(deploymentOwnerId, '24000000-0000-4000-8000-000000000099', 'deployment-mac')
    ];
  }

  private environmentRows(): PersistedRow[] {
    if (this.isLifecycleProof()) return this.lifecycleEnvironments();
    const userAssociation = this.associationState === 'verified' ||
      this.associationState === 'ambiguous' ||
      this.associationState === 'deployment-only' ||
      this.associationState === 'fresh-classification-ineligible'
      ? { host_evidence: 'smbios', host_id: hostId, host_resolution: 'verified' }
      : this.associationState === 'conflict'
        ? { host_evidence: 'host_broker', host_id: hostId, host_resolution: 'conflict' }
        : this.associationState === 'unresolved'
          ? { host_evidence: 'none', host_id: null, host_resolution: 'unresolved' }
          : { host_evidence: 'none', host_id: null, host_resolution: 'not_applicable' };
    const deploymentEnvironmentId = this.associationState === 'deployment-only'
      ? environmentId
      : '1cbcf4d5-985d-4216-8782-6107cb365699';
    return [
      ...(this.associationState === 'fresh-classification' ? [] :
        [environment(userId, environmentId, 'a', 'platform-user', 'User macOS', userAssociation)]),
      environment(
        deploymentOwnerId,
        this.associationState === 'fresh-classification' ? environmentId : deploymentEnvironmentId,
        'x',
        'platform-deployment',
        'Deployment macOS',
        {
          host_evidence: 'smbios',
          host_id: this.associationState === 'deployment-only'
            ? hostId
            : '24000000-0000-4000-8000-000000000099',
          host_resolution: 'verified'
        }
      ),
      environment(
        userId,
        '1cbcf4d5-985d-4216-8782-6107cb365688',
        'x',
        'platform-user',
        'User-defined macOS',
        { host_evidence: 'none', host_id: null, host_resolution: 'unresolved' }
      )
    ];
  }

  private isLifecycleProof() {
    return this.associationState === 'fresh-classification' ||
      this.associationState === 'fresh-classification-ineligible';
  }

  private lifecycleDefinitions(): PersistedRow[] {
    return [
      faithfulDefinition(deploymentOwnerId, 'same-definition-id', 'built_in'),
      faithfulDefinition(userId, 'same-definition-id', 'built_in'),
      definition(userId, 'x', 'user_defined', 'User macOS')
    ];
  }

  private lifecycleEnvironments(): PersistedRow[] {
    const deployment = environment(
      deploymentOwnerId, environmentId, 'same-definition-id', 'platform-deployment',
      'os-macbook.tail1234.ts.net', { host_evidence: 'none', host_id: null, host_resolution: 'unresolved' }
    );
    deployment.resources = { cpu: 4, memoryMb: 8192 };
    deployment.tailscale_projected = this.projectedEnvironmentId === environmentId;
    return [
      ...(this.userRepair ? [this.userRepair] : []),
      deployment,
      environment(
        userId, '1cbcf4d5-985d-4216-8782-6107cb365688', 'x', 'platform-user',
        'User-defined macOS', { host_evidence: 'none', host_id: null, host_resolution: 'unresolved' }
      )
    ];
  }

  private reconcileLifecycle(sql: string) {
    assertReconcilerQueryContract(sql);
    if (!this.isLifecycleProof() || this.classification !== 'environment' || !this.projectedEnvironmentId) return;
    const observedName = this.observed.name.replace(/\.tail[a-z0-9]+\.ts\.net$/i, '');
    const identity = {
      connectorId: 'connector-842', hostname: 'os-macbook.example.test', name: 'os-macbook',
      operatingSystem: 'darwin', ownerUserId: userId, revokedAt: null
    };
    const memberships = [{ connectorId: identity.connectorId, hostId }];
    const candidateHost = {
      id: hostId, identityResolution: 'resolved', ownerUserId: userId,
      platformId: 'platform-user'
    };
    const candidatePlatform = { id: 'platform-user', kind: 'local', name: 'Local & self-hosted' };
    const deploymentDefinition = this.lifecycleDefinitions().find((row) => (
      row.owner_user_id === deploymentOwnerId && row.ownership === 'built_in'
    ));
    const userDefinition = this.lifecycleDefinitions().find((row) => (
      row.owner_user_id === userId && row.ownership === 'built_in'
    ));
    const equivalentDefinition = !!deploymentDefinition && !!userDefinition && [
      'slug', 'name', 'kind', 'operating_system_family', 'bootstrap_strategy', 'ownership',
      'supported_architectures'
    ].every((key) => JSON.stringify(userDefinition[key]) === JSON.stringify(deploymentDefinition[key]));
    const existingUserDefinedSameUuid = this.lifecycleEnvironments().some((row) => row.owner_user_id === userId && row.id === environmentId && this.lifecycleDefinitions().some((candidate) => candidate.owner_user_id === userId && candidate.id === row.environment_definition_id && candidate.ownership === 'user_defined'));
    const exactIdentity = identity.ownerUserId !== deploymentOwnerId && identity.revokedAt === null &&
      observedName === identity.name &&
      [identity.name, identity.hostname.split('.')[0]].includes(observedName) &&
      identity.operatingSystem === 'darwin';
    const eligible = this.associationState === 'fresh-classification' &&
      this.observed.inventoryState === 'current' && this.observed.online &&
      new Date(this.observed.freshUntil) > new Date('2026-08-20T23:30:00.000Z') &&
      exactIdentity && candidatePlatform.kind === 'local' && candidatePlatform.name === 'Local & self-hosted' &&
      candidateHost.ownerUserId === userId && candidateHost.identityResolution === 'resolved' &&
      candidateHost.platformId === candidatePlatform.id && memberships.length === 1 &&
      new Set(memberships.map(({ connectorId }) => connectorId)).size === 1 &&
      new Set(memberships.map(({ hostId: memberHostId }) => memberHostId)).size === 1 &&
      equivalentDefinition && !existingUserDefinedSameUuid;
    if (!eligible) return;
    const deployment = this.lifecycleEnvironments().find((row) => row.owner_user_id === deploymentOwnerId);
    if (!deployment || deployment.host_resolution !== 'unresolved') return;
    this.userRepair = {
      ...deployment,
      environment_definition_id: 'same-definition-id',
      host_evidence: 'user', host_id: hostId, host_resolution: 'manual',
      identity_key: repairedIdentity(userId, 'device-842'),
      identity_resolution: 'resolved', owner_user_id: userId,
      platform_id: 'platform-user'
    };
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function definition(owner: string, id: string, ownership: 'built_in' | 'user_defined', name: string) {
  return {
    bootstrap_strategy: 'none', id, kind: 'native_macos', name,
    operating_system_family: 'macos', owner_user_id: owner, ownership,
    slug: 'macos', supported_architectures: ['arm64']
  };
}

function faithfulDefinition(owner: string, id: string, ownership: 'built_in' | 'user_defined') {
  return {
    bootstrap_strategy: 'ssh', id, kind: 'native_macos', name: 'macOS',
    operating_system_family: 'macos', owner_user_id: owner, ownership,
    slug: 'macos', supported_architectures: ['arm64']
  };
}

const reconcilerEligibilityFragments = [
  'projection.owner_user_id = $1',
  "environment.host_resolution = 'unresolved'",
  "observation.inventory_state = 'current'",
  'observation.online',
  'observation.fresh_until > now()',
  'identity.owner_user_id <> $1',
  'identity.revoked_at is null',
  'identity.operating_system = case environment.kind',
  'machine_connector.owner_user_id = identity.owner_user_id',
  'physical_machine.id = machine_connector.physical_machine_id',
  'host.id = machine_connector.physical_machine_id',
  'host.identity_resolution = \'resolved\'',
  "platform.kind = 'local'",
  "platform.name = 'Local & self-hosted'",
  "deployment_definition.ownership = 'built_in'",
  "definition.ownership = 'built_in'",
  'definition.slug = case environment.kind',
  'deployment_definition.slug, deployment_definition.name',
  'supported_architectures',
  "existing_definition.ownership = 'user_defined'",
  'having count(*) = 1',
  'count(distinct connector_id) = 1',
  'count(distinct host_id) = 1',
  "'manual', 'user'",
  'resource_mode, resources',
  'on conflict (id, owner_user_id) do update'
] as const;

function assertReconcilerQueryContract(sql: string) {
  for (const fragment of reconcilerEligibilityFragments) {
    if (!sql.includes(fragment)) {
      throw new Error(`The reconciliation proof rejected an incomplete SQL contract: ${fragment}`);
    }
  }
}

function repairedIdentity(owner: string, deviceId: string) {
  const first = createHash('md5').update(`environment:${owner}:tailscale:${deviceId}`).digest('hex');
  const second = createHash('md5').update(`tailscale-environment:${owner}:${deviceId}`).digest('hex');
  return `account:${first}${second}`;
}

function host(owner: string, id: string, name: string) {
  return {
    id, identity_key: `host:${owner}:${id}`, identity_version: 1,
    legacy_tombstoned_only: false, name, owner_user_id: owner,
    platform_id: owner === userId ? 'platform-user' : 'platform-deployment', resources: null
  };
}

function environment(
  owner: string,
  id: string,
  definitionId: string,
  platformId: string,
  name: string,
  association: { host_evidence: string; host_id: string | null; host_resolution: string }
) {
  return {
    ...association,
    environment_definition_id: definitionId,
    id,
    identity_key: `environment:${owner}:${id}`,
    identity_resolution: 'resolved',
    identity_version: 1,
    kind: 'native_macos',
    legacy_tombstoned_only: false,
    name,
    owner_user_id: owner,
    parent_environment_id: null,
    platform_id: platformId,
    resource_mode: 'dedicated',
    resources: null
  };
}

function runtimeSessions(commands: WorkspaceRuntimeCodexCommand[]) {
  const listeners = new Set<(message: WorkspaceRuntimeCodexMessage) => Promise<void> | void>();
  const snapshot = {
    branch, capabilities: ['runtime.codex.v1'], codexAcceptedCommandSequence: 0,
    commit, connectionState: 'online', devServers: [], environmentId,
    expiresAt: '2026-08-21T00:00:00.000Z', generation: '22222222-2222-4222-8222-222222222222',
    lastEventAt: '2026-08-20T18:00:00.000Z', lastHeartbeatAt: '2026-08-20T18:00:00.000Z',
    lastSequence: 1, lifecycleState: 'running', manifestDigest: 'b'.repeat(64),
    runtimeVersion: '0.4.66', schemaVersion: 1, sessionId: 'persisted-session-842', workspaceId
  };
  return {
    list: async (owner: string) => owner === userId ? [snapshot] : [],
    onCodexMessage(listener: (message: WorkspaceRuntimeCodexMessage) => Promise<void> | void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatchCodex(_owner: string, command: WorkspaceRuntimeCodexCommand) {
      commands.push(command);
      const result = command.kind === 'start'
        ? { initialTurnId: 'turn-initial-842', machineId: command.request.machineId, threadId: taskThreadId }
        : {
            operationId: command.request.operationId, replayed: false, status: 'accepted' as const,
            threadId: command.request.threadId, turnId: 'turn-send-842'
          };
      queueMicrotask(() => {
        const message = { ...command, result, type: 'runtime.codex.result' } as unknown as WorkspaceRuntimeCodexMessage;
        for (const listener of listeners) void listener(message);
      });
    }
  } as unknown as WorkspaceRuntimeSessionService;
}

async function configuredHttp(state: AssociationState) {
  const database = new PersistedCollisionDatabase(state);
  const repository = new ProjectSpaceDatabaseRepository(database);
  const commands: WorkspaceRuntimeCodexCommand[] = [];
  const runtime = await createConfiguredCodexMachineTasksRuntime({
    backend: configuredBackend() as never,
    database,
    runtimeSessions: runtimeSessions(commands),
    sessionsRuntime: Promise.reject(new Error('Compatibility runtime is outside this path')) as Promise<CodexSessionsRuntime>,
    taskStore: memoryStore(),
    workspaceBindingStore: {
      list: async () => [{ id: 'execution-842' }],
      readWorkspace: async () => ({
        branch, commit, id: workspaceId, state: 'ready',
        target: { kind: 'project_worktree', reference: 'worktree-842' }
      })
    } as never
  });
  const api = createCodexMachineTasksHttpApi(runtime.service, async () => ({
    reportingTask: { role: 'project-manager', threadId: reportingThreadId }, userId
  }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await api(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing integration HTTP address.');
  return {
    commands,
    database,
    repository,
    origin: `http://127.0.0.1:${address.port}`
  };
}

function configuredBackend() {
  return {
    async createGitHubBranch() { throw new Error('The integration path must not create a branch.'); },
    async getGitHubCatalog() {
      return {
        checkedAt: '', repositories: [{
          defaultBranch: 'main', fullName: 'DotNaos/project-space', id: 42,
          isPrivate: true, name: 'project-space', owner: 'DotNaos',
          projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
          url: 'https://github.com/DotNaos/project-space'
        }], status: 'connected' as const
      };
    },
    async getGitHubRepositoryDetails() {
      return {
        branches: [{ commitSha: commit, isDefault: false, name: branch }], checkedAt: '',
        issues: [{ labels: [], number: 842, state: 'open' as const, title: 'Preserve Environment ownership', url: 'https://github.com/DotNaos/project-space/issues/842' }],
        pullRequests: [], status: 'connected' as const
      };
    }
  };
}

function mutation(operationId: string, body: Record<string, unknown>) {
  return {
    body: JSON.stringify({ ...body, operationId }),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId },
    method: 'POST'
  };
}

describe('persisted configured Codex ownership integration', () => {
  test('creates the user row from fresh classification before HTTP start, read, and send', async () => {
    const configured = await configuredHttp('fresh-classification');
    const inventory = new PostgresTailscaleInventoryStore(configured.database);
    const snapshot = {
      backendState: 'running' as const,
      deviceErrors: [],
      devices: [{
        addresses: ['100.64.0.10'], id: 'device-842', observedName: 'os-macbook.tail1234.ts.net',
        online: true, os: 'darwin', tags: []
      }],
      freshness: {
        freshUntil: '2026-08-21T00:00:00.000Z', observedAt: '2026-08-20T23:00:00.000Z', state: 'fresh' as const
      },
      source: 'tailscale_status_json' as const
    };

    const deploymentOnly = await configured.repository.listComputeInventory(userId);
    expect(deploymentOnly.environments.some(({ id }) => id === environmentId)).toBe(false);
    await inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot });
    await inventory.setClassification({
      actorId: 'project-manager', classification: 'environment', deviceId: 'device-842',
      expectedRevision: 0, ownerUserId: deploymentOwnerId
    });

    const repaired = await configured.repository.listComputeInventory(userId);
    expect(repaired.environments.find(({ id }) => id === environmentId)).toMatchObject({
      environmentDefinitionId: 'same-definition-id',
      hostAssociation: { evidence: 'user', hostId, resolution: 'manual' },
      id: environmentId, identityResolution: 'resolved', kind: 'native_macos',
      name: 'os-macbook.tail1234.ts.net', platformId: 'platform-user',
      resourceMode: 'dedicated', resources: { cpu: 4, memoryMb: 8192 },
    });
    expect(repaired.environments.find(({ id }) => id === environmentId)?.identity.key)
      .toBe(repairedIdentity(userId, 'device-842'));

    const start = await fetch(`${configured.origin}/api/codex/tasks/start`, mutation('classification-start-842', {
      expectedBranch: branch, expectedCommit: commit, issue: 842,
      physicalMachineId: hostId, repositoryId: 'DotNaos/project-space'
    }));
    const started = await start.json() as { state: string; task?: { threadId?: string } };
    expect(start.status).toBe(200);
    expect(started).toMatchObject({ state: 'confirmed', task: { physicalMachine: { id: hostId } } });

    const read = await fetch(`${configured.origin}/api/codex/tasks/${started.task?.threadId}?physicalMachineId=${hostId}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ state: 'confirmed', target: { physicalMachine: { id: hostId } } });

    const send = await fetch(
      `${configured.origin}/api/codex/tasks/${started.task?.threadId}/send`,
      mutation('classification-send-842', {
        delivery: 'new-turn', message: 'Continue through fresh classification ownership.', physicalMachineId: hostId
      })
    );
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({ state: 'accepted', target: { physicalMachine: { id: hostId } } });
    expect(configured.commands.map(({ kind, environmentId: selectedEnvironment }) => ({
      kind, selectedEnvironment
    }))).toEqual([
      { kind: 'start', selectedEnvironment: environmentId },
      { kind: 'read', selectedEnvironment: environmentId },
      { kind: 'continue', selectedEnvironment: environmentId }
    ]);
  });

  test('keeps an ineligible deployment Environment deployment-only', async () => {
    const configured = await configuredHttp('fresh-classification-ineligible');
    const inventory = new PostgresTailscaleInventoryStore(configured.database);
    const snapshot = {
      backendState: 'running' as const,
      deviceErrors: [],
      devices: [{
        addresses: ['100.64.0.10'], id: 'device-842', observedName: 'os-macbook.tail1234.ts.net',
        online: true, os: 'darwin', tags: []
      }],
      freshness: {
        freshUntil: '2026-08-20T23:15:00.000Z', observedAt: '2026-08-20T23:00:00.000Z', state: 'fresh' as const
      },
      source: 'tailscale_status_json' as const
    };

    await inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot });
    await inventory.setClassification({
      actorId: 'project-manager', classification: 'environment', deviceId: 'device-842',
      expectedRevision: 0, ownerUserId: deploymentOwnerId
    });

    const inventoryAfter = await configured.repository.listComputeInventory(userId, {
      additionalOwnerUserIds: [deploymentOwnerId]
    });
    expect(inventoryAfter.environments.find(({ id }) => id === environmentId)).toMatchObject({
      id: environmentId,
      hostAssociation: { evidence: 'none', resolution: 'unresolved' }
    });
    expect(inventoryAfter.environments.filter(({ id }) => id === environmentId)).toHaveLength(1);
    expect(configured.database.calls.some(({ sql }) => sql.includes('with candidate_rows'))).toBe(true);
  });

  test('rejects a deliberately incomplete eligibility query contract', async () => {
    const configured = await configuredHttp('fresh-classification');
    const inventory = new PostgresTailscaleInventoryStore(configured.database);
    const snapshot = {
      backendState: 'running' as const, deviceErrors: [],
      devices: [{
        addresses: ['100.64.0.10'], id: 'device-842', observedName: 'os-macbook.tail1234.ts.net',
        online: true, os: 'darwin', tags: []
      }],
      freshness: {
        freshUntil: '2026-08-21T00:00:00.000Z', observedAt: '2026-08-20T23:00:00.000Z', state: 'fresh' as const
      },
      source: 'tailscale_status_json' as const
    };
    await inventory.reconcile(deploymentOwnerId, { complete: true, kind: 'snapshot', snapshot });
    await inventory.setClassification({
      actorId: 'project-manager', classification: 'environment', deviceId: 'device-842',
      expectedRevision: 0, ownerUserId: deploymentOwnerId
    });
    const candidateQuery = configured.database.calls.find(({ sql }) => sql.includes('with candidate_rows'))?.sql;
    expect(candidateQuery).toBeString();
    expect(() => assertReconcilerQueryContract(candidateQuery!.replace('observation.online', 'true'))).toThrow(
      'observation.online'
    );
  });

  test('reconciles persisted owner collisions before HTTP start and send retain the exact Host', async () => {
    const configured = await configuredHttp('verified');
    const reconciledInventory = await configured.repository.listComputeInventory(userId, {
      additionalOwnerUserIds: [deploymentOwnerId]
    });
    const start = await fetch(`${configured.origin}/api/codex/tasks/start`, mutation('persisted-start-842', {
      expectedBranch: branch, expectedCommit: commit, issue: 842,
      physicalMachineId: hostId, repositoryId: 'DotNaos/project-space'
    }));
    const started = await start.json() as { state: string; task?: { threadId?: string } };
    expect(start.status).toBe(200);
    expect(started).toMatchObject({ state: 'confirmed', task: { physicalMachine: { id: hostId, name: 'os-macbook' } } });

    const send = await fetch(
      `${configured.origin}/api/codex/tasks/${started.task?.threadId}/send`,
      mutation('persisted-send-842', {
        delivery: 'new-turn', message: 'Continue through the persisted owner boundary.',
        physicalMachineId: hostId
      })
    );
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({ state: 'accepted', target: { physicalMachine: { id: hostId } } });
    expect(configured.database.returnedDefinitionOwners).toEqual([
      `${userId}:a`, `${deploymentOwnerId}:x`, `${userId}:x`,
      `${userId}:a`, `${userId}:x`,
      `${userId}:a`, `${userId}:x`
    ]);
    expect(configured.database.calls
      .filter(({ sql }) => sql.includes('from compute_environment_definitions'))
      .map(({ values }) => values[0])).toEqual([visibleOwners, [userId], [userId]]);
    expect(reconciledInventory.environmentDefinitions.map(({ id, ownership }) => ({ id, ownership }))).toEqual([
      { id: 'a', ownership: 'built_in' }, { id: 'x', ownership: 'user_defined' }
    ]);
    expect(reconciledInventory.environments.find(({ id }) => id.endsWith('5699'))?.environmentDefinitionId).toBe('a');
    expect(reconciledInventory.environments.find(({ id }) => id.endsWith('5688'))?.environmentDefinitionId).toBe('x');
    expect(configured.commands.map(({ kind, environmentId: selectedEnvironment }) => ({
      kind, selectedEnvironment
    }))).toEqual([
      { kind: 'start', selectedEnvironment: environmentId },
      { kind: 'continue', selectedEnvironment: environmentId }
    ]);
    expect(configured.commands[0]?.request.machineId).toBe(configured.commands[1]?.request.machineId);
  });

  test.each(['deployment-only', 'ambiguous', 'missing', 'unresolved', 'conflict'] as const)(
    'blocks %s persisted Host association evidence before dispatch',
    async (state) => {
      const configured = await configuredHttp(state);
      await configured.repository.listComputeInventory(userId, {
        additionalOwnerUserIds: [deploymentOwnerId]
      });
      const response = await fetch(`${configured.origin}/api/codex/tasks/start`, mutation(`persisted-${state}-842`, {
        expectedBranch: branch, expectedCommit: commit, issue: 842,
        physicalMachineId: hostId, repositoryId: 'DotNaos/project-space'
      }));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ reason: 'unauthorized', state: 'blocked' });
      if (state === 'deployment-only' || state === 'ambiguous') {
        expect(result).toMatchObject({ message: 'Select one exact physical machine.' });
        expect(result).not.toHaveProperty('unavailable');
      } else {
        expect(result).toMatchObject({
          unavailable: {
            kind: 'environment_host_association',
            state: state === 'conflict' ? 'conflicting' : state
          }
        });
        expect(result.message).toContain(state === 'conflict' ? 'Resolve' : 'Assign');
      }
      expect(configured.database.returnedDefinitionOwners).toEqual([
        `${userId}:a`, `${deploymentOwnerId}:x`, `${userId}:x`,
        `${userId}:a`, `${userId}:x`
      ]);
      expect(configured.commands).toEqual([]);
    }
  );
});
