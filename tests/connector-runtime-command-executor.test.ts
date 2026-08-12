import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  connectorRuntimeCommandSchema,
  createConnectorRuntimeCommandWireRequest,
  type ConnectorRuntimeCommandFingerprint,
  type ConnectorRuntimeCommandPlan
} from '../server/connector-runtime-command-contract';
import {
  ConnectorRuntimeCommandExecutor,
  isConnectorRuntimeSupervisorControlRequest,
  type ConnectorRuntimeCommandAcceptedResult,
  type ConnectorRuntimeCommandStageEvent
} from '../server/connector-runtime-command-executor';
import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck,
  type ConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';
import {
  canonicalConnectorRuntimeReleaseManifest,
  connectorRuntimeReleaseManifestSchema,
  type ConnectorRuntimeReleaseManifest,
  type SignedConnectorRuntimeReleaseManifest
} from '../server/connector-runtime-release-manifest';

const now = Date.parse('2026-07-14T00:00:00.000Z');
const commandKeys = generateKeyPairSync('ed25519');
const releaseKeys = generateKeyPairSync('ed25519');
const artifactBytes = new TextEncoder().encode('safe connector release');

const previousRuntime: ConnectorRuntimeCommandFingerprint = {
  buildId: '0'.repeat(40),
  bundleVersions: {
    connector: '0.4.0',
    machineTools: '0.4.0',
    projectCli: '0.4.0'
  },
  capabilities: ['runtime.restart', 'runtime.update'],
  instanceId: 'instance-current',
  protocolVersion: '2',
  releaseId: 'v0.4.0',
  version: '0.4.0'
};

function manifest(
  overrides: Partial<ConnectorRuntimeReleaseManifest> = {}
): ConnectorRuntimeReleaseManifest {
  return {
    artifacts: [{
      assetName: 'project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz',
      bundleVersions: {
        connector: '0.5.0',
        machineTools: '0.5.0',
        projectCli: '0.5.0'
      },
      capabilities: ['runtime.restart', 'runtime.update'],
      downloadUrl:
        'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz',
      protocolVersion: '2',
      sha256: createHash('sha256').update(artifactBytes).digest('hex'),
      sizeBytes: artifactBytes.byteLength,
      target: 'darwin-arm64'
    }],
    buildId: '1'.repeat(40),
    channel: 'stable',
    expiresAt: '2026-07-15T00:00:00.000Z',
    issuedAt: '2026-07-13T23:00:00.000Z',
    releaseId: 'v0.5.0',
    schema: connectorRuntimeReleaseManifestSchema,
    source: 'managed',
    version: '0.5.0',
    ...overrides
  };
}

function signedRelease(
  value: ConnectorRuntimeReleaseManifest,
  privateKey: KeyObject = releaseKeys.privateKey
): SignedConnectorRuntimeReleaseManifest {
  return {
    manifest: value,
    signature: sign(
      null,
      Buffer.from(canonicalConnectorRuntimeReleaseManifest(value), 'utf8'),
      privateKey
    ).toString('base64url')
  };
}

function plan(operation: 'restart' | 'update'): ConnectorRuntimeCommandPlan {
  const base = {
    machineId: 'machine-1',
    operationId: `operation-${operation}`,
    previousRuntime,
    schema: connectorRuntimeCommandSchema,
    target: 'darwin-arm64' as const
  };
  return operation === 'restart'
    ? { ...base, operation }
    : {
        ...base,
        operation,
        release: signedRelease(manifest()),
        releaseId: 'v0.5.0'
      };
}

function command(operation: 'restart' | 'update') {
  return createConnectorRuntimeCommandWireRequest(
    { generation: 7, plan: plan(operation), userId: 'user-owner' },
    commandKeys.privateKey,
    { nonce: `nonce-${operation}`, now }
  );
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'connector-runtime-executor-'));
  return {
    control: join(root, 'supervisor', 'control.json'),
    root,
    staging: join(root, 'staging')
  };
}

function executor(input: {
  control: string;
  fetchArtifact?: (url: string, init: RequestInit) => Promise<Response>;
  maintenanceSafety?: ConnectorRuntimeMaintenanceSafetyCheck;
  shutdowns: ConnectorRuntimeCommandAcceptedResult[];
  stages: ConnectorRuntimeCommandStageEvent[];
  staging: string;
}) {
  const maintenanceSafety = input.maintenanceSafety ?? createConnectorRuntimeMaintenanceSafetyCheck(
    new ConnectorRuntimeMaintenanceAdmission(),
    { maintenanceBlockers: () => [] }
  );
  return new ConnectorRuntimeCommandExecutor({
    commandVerificationKey: commandKeys.publicKey,
    controlFilePath: input.control,
    emitStage: (stage) => input.stages.push(stage),
    expectedGeneration: 7,
    expectedMachineId: 'machine-1',
    expectedTarget: 'darwin-arm64',
    fetchArtifact: input.fetchArtifact,
    maintenanceSafety,
    now: () => now,
    releaseVerificationKey: releaseKeys.publicKey,
    shutdown: async (result) => {
      expect(existsSync(input.control)).toBe(true);
      expect(input.stages.at(-1)?.stage).toBe('accepted');
      input.shutdowns.push(result);
    },
    stagingDirectory: input.staging
  });
}

describe('connector runtime command executor', () => {
  test('allows the same signed operation to retry after a busy deferral', async () => {
    const paths = workspace();
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    let busy = true;
    const runtimeExecutor = executor({
      control: paths.control,
      maintenanceSafety: createConnectorRuntimeMaintenanceSafetyCheck(
        admission,
        {
          maintenanceBlockers: () => busy
            ? [{ kind: 'codex-turn', state: 'active', threadId: 'thread-busy' }]
            : []
        }
      ),
      shutdowns: [],
      stages: [],
      staging: paths.staging
    });
    const request = command('restart');
    try {
      await expect(runtimeExecutor.execute(request)).rejects.toMatchObject({
        code: 'codex-turn-active'
      });
      busy = false;
      await expect(runtimeExecutor.execute(request)).resolves.toMatchObject({
        operationId: 'operation-restart',
        status: 'accepted'
      });
    } finally {
      rmSync(paths.root, { force: true, recursive: true });
    }
  });

  test('rejects blockers and uncertain safety checks before runtime side effects', async () => {
    const checks: Array<{
      code: string;
      maintenanceSafety: ConnectorRuntimeMaintenanceSafetyCheck;
    }> = [
      {
        code: 'codex-turn-active',
        maintenanceSafety: () => ({
          blockers: [{ kind: 'codex-turn', state: 'active', threadId: 'thread-1' }],
          certainty: 'known'
        })
      },
      {
        code: 'codex-turn-starting',
        maintenanceSafety: () => ({
          blockers: [{ kind: 'codex-turn', state: 'starting', threadId: 'thread-2' }],
          certainty: 'known'
        })
      },
      {
        code: 'codex-waiting-approval',
        maintenanceSafety: () => ({
          blockers: [{
            kind: 'codex-request', requestId: 1, state: 'waiting-for-approval',
            threadId: 'thread-3'
          }],
          certainty: 'known'
        })
      },
      {
        code: 'codex-waiting-input',
        maintenanceSafety: () => ({
          blockers: [{
            kind: 'codex-request', requestId: 2, state: 'waiting-for-user-input',
            threadId: 'thread-4'
          }],
          certainty: 'known'
        })
      },
      {
        code: 'codex-state-uncertain',
        maintenanceSafety: () => ({
          blockers: [{ kind: 'codex-runtime', state: 'uncertain' }], certainty: 'known'
        })
      },
      {
        code: 'machine-mutation',
        maintenanceSafety: () => ({
          blockers: [{ count: 1, kind: 'connector-activity', scope: 'terminal' }],
          certainty: 'known'
        })
      },
      {
        code: 'codex-turn-active',
        maintenanceSafety: () => ({
          blockers: [{ count: 1, kind: 'connector-activity', scope: 'codex-chat' }],
          certainty: 'known'
        })
      },
      { code: 'codex-state-uncertain', maintenanceSafety: () => ({ certainty: 'uncertain' }) },
      {
        code: 'codex-state-uncertain',
        maintenanceSafety: () => { throw new Error('state unavailable'); }
      }
    ];
    for (const { code, maintenanceSafety } of checks) {
      const paths = workspace();
      const stages: ConnectorRuntimeCommandStageEvent[] = [];
      const shutdowns: ConnectorRuntimeCommandAcceptedResult[] = [];
      let fetched = false;
      try {
        await expect(executor({
          control: paths.control,
          fetchArtifact: async () => {
            fetched = true;
            return new Response(artifactBytes);
          },
          maintenanceSafety,
          shutdowns,
          stages,
          staging: paths.staging
        }).execute(command('restart'))).rejects.toMatchObject({ code });
        expect(existsSync(paths.control)).toBe(false);
        expect(existsSync(paths.staging)).toBe(false);
        expect(fetched).toBe(false);
        expect(shutdowns).toEqual([]);
        expect(stages).toEqual([]);
      } finally {
        rmSync(paths.root, { force: true, recursive: true });
      }
    }
  });

  test('releases failed maintenance admission and keeps published maintenance closed', async () => {
    const failedAdmission = new ConnectorRuntimeMaintenanceAdmission();
    const failedPaths = workspace();
    try {
      await expect(executor({
        control: failedPaths.control,
        fetchArtifact: async () => { throw new Error('download failed'); },
        maintenanceSafety: createConnectorRuntimeMaintenanceSafetyCheck(
          failedAdmission, { maintenanceBlockers: () => [] }
        ),
        shutdowns: [],
        stages: [],
        staging: failedPaths.staging
      }).execute(command('update'))).rejects.toMatchObject({ code: 'download-failed' });
      const activity = failedAdmission.tryBeginActivity('codex');
      expect(activity).toBeDefined();
      activity?.release();
    } finally {
      rmSync(failedPaths.root, { force: true, recursive: true });
    }

    const acceptedAdmission = new ConnectorRuntimeMaintenanceAdmission();
    const acceptedPaths = workspace();
    try {
      await executor({
        control: acceptedPaths.control,
        maintenanceSafety: createConnectorRuntimeMaintenanceSafetyCheck(
          acceptedAdmission, { maintenanceBlockers: () => [] }
        ),
        shutdowns: [],
        stages: [],
        staging: acceptedPaths.staging
      }).execute(command('restart'));
      expect(acceptedAdmission.tryBeginActivity('codex')).toBeUndefined();
    } finally {
      rmSync(acceptedPaths.root, { force: true, recursive: true });
    }
  });

  test('accepts restart while current without downloading or inventing an artifact', async () => {
    const paths = workspace();
    const stages: ConnectorRuntimeCommandStageEvent[] = [];
    const shutdowns: ConnectorRuntimeCommandAcceptedResult[] = [];
    let fetched = false;
    try {
      const result = await executor({
        control: paths.control,
        fetchArtifact: async () => {
          fetched = true;
          throw new Error('restart must not fetch');
        },
        shutdowns,
        stages,
        staging: paths.staging
      }).execute(command('restart'));

      expect(result).toEqual({
        operation: 'restart',
        operationId: 'operation-restart',
        status: 'accepted'
      });
      expect(fetched).toBe(false);
      const control: unknown = JSON.parse(readFileSync(paths.control, 'utf8'));
      expect(isConnectorRuntimeSupervisorControlRequest(control)).toBe(true);
      expect(Object.keys(control as object).sort()).toEqual(['command', 'schema']);
      expect(stages.map((entry) => entry.stage)).toEqual(['validating', 'accepted']);
      expect(shutdowns).toEqual([result]);
    } finally {
      rmSync(paths.root, { force: true, recursive: true });
    }
  });

  test('downloads, verifies, stages, and atomically publishes an update control request', async () => {
    const paths = workspace();
    const stages: ConnectorRuntimeCommandStageEvent[] = [];
    const shutdowns: ConnectorRuntimeCommandAcceptedResult[] = [];
    const requested: string[] = [];
    try {
      const result = await executor({
        control: paths.control,
        fetchArtifact: async (url) => {
          requested.push(url);
          return new Response(artifactBytes, {
            headers: { 'content-length': String(artifactBytes.byteLength) },
            status: 200
          });
        },
        shutdowns,
        stages,
        staging: paths.staging
      }).execute(command('update'));

      expect(requested).toEqual([
        manifest().artifacts[0]!.downloadUrl
      ]);
      const control = JSON.parse(readFileSync(paths.control, 'utf8')) as Record<string, unknown>;
      expect(isConnectorRuntimeSupervisorControlRequest(control)).toBe(true);
      expect(Object.keys(control).sort()).toEqual(['artifact', 'command', 'schema']);
      const artifact = control.artifact as { path: string; sha256: string; sizeBytes: number };
      expect(readFileSync(artifact.path)).toEqual(Buffer.from(artifactBytes));
      expect(artifact).toMatchObject({
        sha256: manifest().artifacts[0]!.sha256,
        sizeBytes: artifactBytes.byteLength
      });
      expect(stages.map((entry) => entry.stage)).toEqual([
        'validating', 'staging', 'verifying', 'accepted'
      ]);
      expect(shutdowns).toEqual([result]);
    } finally {
      rmSync(paths.root, { force: true, recursive: true });
    }
  });

  test('rejects the wrong size or hash without publishing control or shutting down', async () => {
    for (const failure of ['size', 'hash'] as const) {
      const paths = workspace();
      const stages: ConnectorRuntimeCommandStageEvent[] = [];
      const shutdowns: ConnectorRuntimeCommandAcceptedResult[] = [];
      const release = manifest();
      release.artifacts[0] = {
        ...release.artifacts[0]!,
        ...(failure === 'size'
          ? { sizeBytes: artifactBytes.byteLength + 1 }
          : { sha256: 'f'.repeat(64) })
      };
      const update = plan('update');
      if (update.operation !== 'update') throw new Error('Expected update plan.');
      update.release = signedRelease(release);
      const request = createConnectorRuntimeCommandWireRequest(
        { generation: 7, plan: update, userId: 'user-owner' },
        commandKeys.privateKey,
        { nonce: `nonce-${failure}`, now }
      );
      try {
        await expect(executor({
          control: paths.control,
          fetchArtifact: async () => new Response(artifactBytes, {
            headers: { 'content-length': String(artifactBytes.byteLength) },
            status: 200
          }),
          shutdowns,
          stages,
          staging: paths.staging
        }).execute(request)).rejects.toMatchObject({ code: 'integrity-failed' });
        expect(existsSync(paths.control)).toBe(false);
        expect(shutdowns).toHaveLength(0);
      } finally {
        rmSync(paths.root, { force: true, recursive: true });
      }
    }
  });

  test('cleans an interrupted download and rejects arbitrary request fields', async () => {
    const paths = workspace();
    const stages: ConnectorRuntimeCommandStageEvent[] = [];
    const shutdowns: ConnectorRuntimeCommandAcceptedResult[] = [];
    try {
      const interrupted = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(artifactBytes.slice(0, 4));
          controller.error(new Error('connection lost'));
        }
      });
      await expect(executor({
        control: paths.control,
        fetchArtifact: async () => new Response(interrupted, { status: 200 }),
        shutdowns,
        stages,
        staging: paths.staging
      }).execute(command('update'))).rejects.toMatchObject({ code: 'download-failed' });
      expect(existsSync(paths.control)).toBe(false);
      expect(readdirSync(paths.staging)).toEqual([]);
      expect(shutdowns).toHaveLength(0);

      const arbitrary = command('restart') as unknown as Record<string, unknown>;
      (arbitrary.plan as Record<string, unknown>).url = 'https://attacker.invalid/payload';
      await expect(executor({
        control: paths.control,
        shutdowns,
        stages: [],
        staging: paths.staging
      }).execute(arbitrary)).rejects.toMatchObject({ code: 'invalid-schema' });
    } finally {
      rmSync(paths.root, { force: true, recursive: true });
    }
  });
});
