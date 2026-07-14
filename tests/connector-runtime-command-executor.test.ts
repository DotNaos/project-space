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
  shutdowns: ConnectorRuntimeCommandAcceptedResult[];
  stages: ConnectorRuntimeCommandStageEvent[];
  staging: string;
}) {
  return new ConnectorRuntimeCommandExecutor({
    commandVerificationKey: commandKeys.publicKey,
    controlFilePath: input.control,
    emitStage: (stage) => input.stages.push(stage),
    expectedGeneration: 7,
    expectedMachineId: 'machine-1',
    expectedTarget: 'darwin-arm64',
    fetchArtifact: input.fetchArtifact,
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
