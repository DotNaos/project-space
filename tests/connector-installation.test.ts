import type { IncomingMessage } from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  createConnectorInstaller,
  connectorCompatibilityInstallerVersion,
  connectorCompatibilityPolicy,
  connectorInstallScript,
  connectorInstallerReleaseConfig,
  requestPublicOrigin
} from '../server/connector-installation';
import {
  canonicalConnectorRuntimeReleaseManifest,
  connectorRuntimeReleaseManifestSchema,
  type ConnectorRuntimeReleaseManifest
} from '../server/connector-runtime-release-manifest';

const originalPublicOrigin = process.env.PROJECT_SPACE_PUBLIC_ORIGIN;
const temporaryDirectories: string[] = [];
const manifestNow = Date.parse('2026-07-14T12:00:00.000Z');
const manifestCompatibilityUntil = String(Math.floor((manifestNow + 30 * 24 * 60 * 60 * 1000) / 1000));

afterEach(() => {
  if (originalPublicOrigin === undefined) {
    delete process.env.PROJECT_SPACE_PUBLIC_ORIGIN;
  } else {
    process.env.PROJECT_SPACE_PUBLIC_ORIGIN = originalPublicOrigin;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

interface TarEntry {
  contents?: string;
  mode?: number;
  name: string;
  type?: 'directory' | 'file';
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number
) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function writeTarGzip(path: string, entries: TarEntry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.type === 'directory' ? 0 : contents.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type === 'directory' ? '5' : '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header);
    if (entry.type !== 'directory') {
      chunks.push(contents);
      const padding = (512 - (contents.length % 512)) % 512;
      if (padding > 0) {
        chunks.push(Buffer.alloc(padding));
      }
    }
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(path, gzipSync(Buffer.concat(chunks)));
}

function completeBundleEntries(bundleRoot: string): TarEntry[] {
  return [
    { name: `${bundleRoot}/`, mode: 0o755, type: 'directory' },
    { name: `${bundleRoot}/SHA256SUMS.txt`, contents: 'fixture checksums\n' },
    { name: `${bundleRoot}/VERSION`, contents: '0.3.0\n' },
    {
      name: `${bundleRoot}/connector-command-signing-public-key.pem`,
      contents: 'fixture command key\n'
    },
    {
      name: `${bundleRoot}/install.sh`,
      contents: '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" > "$INSTALL_MARKER"\n',
      mode: 0o755
    },
    { name: `${bundleRoot}/project`, contents: 'fixture project\n', mode: 0o755 },
    {
      name: `${bundleRoot}/project-space-connector`,
      contents: 'fixture connector\n',
      mode: 0o755
    },
    {
      name: `${bundleRoot}/release-manifest-signing-public-key.pem`,
      contents: 'fixture release key\n'
    }
  ];
}

function approvedManifest(
  overrides: Partial<ConnectorRuntimeReleaseManifest> = {}
): ConnectorRuntimeReleaseManifest {
  return {
    artifacts: [
      {
        assetName: 'project-space-machine-tools-darwin-arm64-v0.3.0.tar.gz',
        bundleVersions: {
          connector: '0.3.0',
          machineTools: '0.3.0',
          projectCli: '0.3.0'
        },
        capabilities: ['runtime.restart', 'runtime.update'],
        downloadUrl:
          'https://github.com/DotNaos/project-space/releases/download/v0.3.0/project-space-machine-tools-darwin-arm64-v0.3.0.tar.gz',
        protocolVersion: '2',
        sha256: 'a'.repeat(64),
        sizeBytes: 10_000_000,
        target: 'darwin-arm64'
      }
    ],
    buildId: '1'.repeat(40),
    channel: 'stable',
    expiresAt: '2026-07-15T12:00:00.000Z',
    issuedAt: '2026-07-13T12:00:00.000Z',
    releaseId: 'v0.3.0',
    schema: connectorRuntimeReleaseManifestSchema,
    source: 'managed',
    version: '0.3.0',
    ...overrides
  };
}

function signedManifest(
  manifest: ConnectorRuntimeReleaseManifest,
  privateKey: KeyObject
) {
  return {
    manifest,
    signature: sign(
      null,
      Buffer.from(canonicalConnectorRuntimeReleaseManifest(manifest), 'utf8'),
      privateKey
    ).toString('base64url')
  };
}

function runGeneratedInstaller(entries: TarEntry[], expectedSha256?: string) {
  const root = mkdtempSync(join(tmpdir(), 'project-space-installer-test-'));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  const installDirectory = join(root, 'bin');
  const fixtureArchive = join(root, 'fixture.tar.gz');
  const marker = join(root, 'installed.txt');
  const stubDirectory = join(root, 'stubs');
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(stubDirectory, { recursive: true });
  writeFileSync(
    join(home, 'Library', 'LaunchAgents', 'net.os-home.project-space.machine-connector-supervisor.plist'),
    'fixture managed service\n'
  );
  writeTarGzip(fixtureArchive, entries);
  writeFileSync(
    join(stubDirectory, 'curl'),
    '#!/usr/bin/env bash\nset -euo pipefail\ndestination=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then destination=$2; shift 2; else shift; fi\ndone\ncp "$FIXTURE_ARCHIVE" "$destination"\n'
  );
  writeFileSync(
    join(stubDirectory, 'uname'),
    '#!/usr/bin/env bash\nif [ "${1:-}" = "-s" ]; then printf "Darwin\\n"; else printf "arm64\\n"; fi\n'
  );
  chmodSync(join(stubDirectory, 'curl'), 0o755);
  chmodSync(join(stubDirectory, 'uname'), 0o755);
  const archiveSha256 = createHash('sha256')
    .update(readFileSync(fixtureArchive))
    .digest('hex');
  const result = spawnSync('bash', [], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FIXTURE_ARCHIVE: fixtureArchive,
      HOME: home,
      INSTALL_MARKER: marker,
      PATH: `${stubDirectory}:${process.env.PATH ?? ''}`,
      PROJECT_CONNECTOR_SERVICE_NAME: 'test-machine',
      PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET:
        'project-space-machine-tools-darwin-arm64-v0.3.0.tar.gz',
      PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256: expectedSha256 ?? archiveSha256,
      PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION: 'v0.3.0',
      PROJECT_SPACE_CONNECTOR_COMPATIBILITY_ACK: connectorCompatibilityInstallerVersion,
      PROJECT_SPACE_CONNECTOR_COMPATIBILITY_INSTALL_UNTIL_EPOCH: String(
        Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000)
      ),
      PROJECT_SPACE_CONNECTOR_DIR: installDirectory
    },
    input: connectorInstallScript('https://projects.os-home.net')
  });
  return { marker, result, root };
}

function request(
  headers: IncomingMessage['headers'],
  encrypted = false
) {
  return {
    headers,
    socket: { encrypted }
  } as IncomingMessage;
}

describe('connector installation origin', () => {
  test('uses an explicitly configured deployment origin', () => {
    process.env.PROJECT_SPACE_PUBLIC_ORIGIN = 'https://beta.projects.os-home.net';

    expect(requestPublicOrigin(request({ host: 'attacker.invalid' }))).toBe(
      'https://beta.projects.os-home.net'
    );
  });

  test('accepts a plain local origin and rejects unsafe forwarded hosts', () => {
    delete process.env.PROJECT_SPACE_PUBLIC_ORIGIN;

    expect(requestPublicOrigin(request({ host: '127.0.0.1:4173' }))).toBe(
      'http://127.0.0.1:4173'
    );
    expect(
      requestPublicOrigin(
        request({
          host: '127.0.0.1:4173',
          'x-forwarded-host': 'example.com/$(touch injected)',
          'x-forwarded-proto': 'https'
        })
      )
    ).toBe('https://projects.os-home.net');
  });

  test('quotes the trusted hub origin in the generated shell script', () => {
    expect(connectorInstallScript('https://projects.os-home.net')).toContain(
      "hub_url='https://projects.os-home.net'"
    );
  });

  test('accepts only a pinned release tag, matching macOS asset, and checksum', () => {
    const manifest = approvedManifest();
    const artifact = manifest.artifacts[0]!;

    expect(connectorInstallerReleaseConfig(manifest, artifact)).toEqual({
      asset: 'project-space-machine-tools-darwin-arm64-v0.3.0.tar.gz',
      sha256: 'a'.repeat(64),
      version: 'v0.3.0'
    });
    expect(() =>
      connectorInstallerReleaseConfig(manifest, {
        ...artifact,
        assetName: 'project-space-machine-tools-darwin-arm64-v0.4.0.tar.gz'
      })
    ).toThrow('must match');
    expect(() =>
      connectorInstallerReleaseConfig(
        { ...manifest, releaseId: 'v0.4.0' },
        artifact
      )
    ).toThrow('exact release tag');
    expect(() =>
      connectorInstallerReleaseConfig(manifest, {
        ...artifact,
        sha256: 'not-a-checksum'
      })
    ).toThrow('SHA-256');
  });

  test('derives the install command from the verified approved release manifest', async () => {
    const keys = generateKeyPairSync('ed25519');
    const manifest = approvedManifest();
    const requestedReleaseIds: Array<string | undefined> = [];
    const installer = await createConnectorInstaller(
      'https://projects.os-home.net',
      {
        environment: {
          PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID: 'v0.3.0',
          PROJECT_SPACE_CONNECTOR_COMPATIBILITY_INSTALL_UNTIL_EPOCH: manifestCompatibilityUntil
        },
        manifestPublicKey: keys.publicKey,
        now: manifestNow,
        releases: {
          async loadApprovedManifest(releaseId) {
            requestedReleaseIds.push(releaseId);
            return signedManifest(manifest, keys.privateKey);
          }
        }
      }
    );

    expect(requestedReleaseIds).toEqual(['v0.3.0']);
    expect(installer.command).toContain(
      "PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION='v0.3.0'"
    );
    expect(installer.command).toContain(
      "PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET='project-space-machine-tools-darwin-arm64-v0.3.0.tar.gz'"
    );
    expect(installer.command).toContain(
      `PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256='${'a'.repeat(64)}'`
    );
    expect(installer.command).toContain(
      `PROJECT_SPACE_CONNECTOR_COMPATIBILITY_ACK='${connectorCompatibilityInstallerVersion}'`
    );
    expect(installer.compatibility).toEqual({
      surface: 'legacy-connector-installer',
      sunsetAt: new Date(Number(manifestCompatibilityUntil) * 1000).toISOString(),
      sunsetEpochSeconds: Number(manifestCompatibilityUntil),
      version: connectorCompatibilityInstallerVersion
    });
  });

  test('fails closed outside an explicit short compatibility window', () => {
    expect(() => connectorCompatibilityPolicy({}, manifestNow)).toThrow(
      'approved connector runtime release is unavailable'
    );
    expect(() => connectorCompatibilityPolicy({
      PROJECT_SPACE_CONNECTOR_COMPATIBILITY_INSTALL_UNTIL_EPOCH: String(
        Math.floor((manifestNow + 91 * 24 * 60 * 60 * 1000) / 1000)
      )
    }, manifestNow)).toThrow('approved connector runtime release is unavailable');
    expect(connectorCompatibilityPolicy({
      PROJECT_SPACE_CONNECTOR_COMPATIBILITY_INSTALL_UNTIL_EPOCH: manifestCompatibilityUntil
    }, manifestNow).version).toBe(connectorCompatibilityInstallerVersion);
  });

  test('rejects missing trust configuration and a tampered approved manifest', async () => {
    const keys = generateKeyPairSync('ed25519');
    const envelope = signedManifest(approvedManifest(), keys.privateKey);
    envelope.manifest.artifacts[0] = {
      ...envelope.manifest.artifacts[0]!,
      sha256: 'b'.repeat(64)
    };
    let releaseLoads = 0;
    const releases = {
      async loadApprovedManifest() {
        releaseLoads += 1;
        return envelope;
      }
    };

    await expect(
      createConnectorInstaller('https://projects.os-home.net', {
        environment: {
          PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID: 'v0.3.0',
          PROJECT_SPACE_CONNECTOR_COMPATIBILITY_INSTALL_UNTIL_EPOCH: manifestCompatibilityUntil
        },
        releases
      })
    ).rejects.toThrow('approved connector runtime release is unavailable');
    expect(releaseLoads).toBe(0);

    await expect(
      createConnectorInstaller('https://projects.os-home.net', {
        environment: {
          PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID: 'v0.3.0',
          PROJECT_SPACE_CONNECTOR_COMPATIBILITY_INSTALL_UNTIL_EPOCH: manifestCompatibilityUntil
        },
        manifestPublicKey: keys.publicKey,
        now: manifestNow,
        releases
      })
    ).rejects.toThrow('signature is invalid');
    expect(releaseLoads).toBe(1);
  });

  test('installs only the managed pinned bundle and refuses unsafe legacy replacement', () => {
    const script = connectorInstallScript('https://projects.os-home.net');

    expect(script).toContain('releases/download/$bundle_version/$bundle_asset');
    expect(script).not.toContain('/releases/latest/');
    expect(script).toContain('shasum -a 256');
    expect(script).toContain('expected_bundle_root="${bundle_asset%.tar.gz}"');
    expect(script).toContain('LC_ALL=C tar -tzf "$archive"');
    expect(script).toContain('tar -xOzf "$archive"');
    expect(script).toContain('"$bundle_root/install.sh" --install-dir "$install_dir"');
    expect(script).not.toContain('install -m 0755 "$tmp_dir/project-space-connector"');
    expect(script).toContain('net.os-home.project-space.machine-connector-supervisor.plist');
    expect(script).toContain('the existing machine identity and settings were preserved');
    expect(script).toContain(
      'The managed identity will be preserved and the legacy service will be removed after a healthy reconnect.'
    );
    expect(script).not.toContain(
      'Both legacy and managed connector services exist. Resolve that conflict before reinstalling.'
    );
    expect(script).toContain('connector-command-signing-public-key.pem');
    expect(script).toContain('release-manifest-signing-public-key.pem');
    expect(script).toContain('Automatic replacement is blocked because that identity cannot be preserved safely.');
    expect(script).toContain('"$install_dir/project" connect');
    expect(script).not.toContain('PROJECT_CONNECTOR_ENROLLMENT_CREDENTIAL');
    expect(script).not.toContain('PROJECT_SPACE_INSTALL_SOURCE');
    expect(script).not.toContain('<plist version=');
    expect(script.indexOf('Automatic replacement is blocked')).toBeLessThan(
      script.indexOf('"$bundle_root/install.sh" --install-dir "$install_dir"')
    );
    expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
  });

  test('runs the installer from one complete versioned release bundle', () => {
    const bundleRoot = 'project-space-machine-tools-darwin-arm64-v0.3.0';
    const { marker, result } = runGeneratedInstaller(completeBundleEntries(bundleRoot));

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toContain('--install-dir');
  });

  test('accepts only an empty legacy approval marker during the removal transition', () => {
    const bundleRoot = 'project-space-machine-tools-darwin-arm64-v0.3.0';
    const compatible = runGeneratedInstaller([
      ...completeBundleEntries(bundleRoot),
      { name: `${bundleRoot}/project-approval-signer`, contents: '', mode: 0o755 }
    ]);
    const executableReplacement = runGeneratedInstaller([
      ...completeBundleEntries(bundleRoot),
      {
        name: `${bundleRoot}/project-approval-signer`,
        contents: '#!/bin/sh\nexit 0\n',
        mode: 0o755
      }
    ]);

    expect(compatible.result.status, compatible.result.stderr).toBe(0);
    expect(readFileSync(compatible.marker, 'utf8')).toContain('--install-dir');
    expect(executableReplacement.result.status).not.toBe(0);
    expect(existsSync(executableReplacement.marker)).toBe(false);
  });

  test('rejects an archive that does not match the pinned checksum', () => {
    const bundleRoot = 'project-space-machine-tools-darwin-arm64-v0.3.0';
    const { marker, result } = runGeneratedInstaller(
      completeBundleEntries(bundleRoot),
      'b'.repeat(64)
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('checksum mismatch');
    expect(existsSync(marker)).toBe(false);
  });

  test('rejects an archive with more than one versioned bundle root', () => {
    const bundleRoot = 'project-space-machine-tools-darwin-arm64-v0.3.0';
    const { marker, result } = runGeneratedInstaller([
      ...completeBundleEntries(bundleRoot),
      {
        name: 'project-space-machine-tools-darwin-arm64-v9.9.9/',
        mode: 0o755,
        type: 'directory'
      },
      {
        name: 'project-space-machine-tools-darwin-arm64-v9.9.9/VERSION',
        contents: '9.9.9\n'
      }
    ]);

    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('rejects duplicate release bundle members', () => {
    const bundleRoot = 'project-space-machine-tools-darwin-arm64-v0.3.0';
    const { marker, result } = runGeneratedInstaller([
      ...completeBundleEntries(bundleRoot),
      { name: `${bundleRoot}/VERSION`, contents: '0.3.0\n' }
    ]);

    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('rejects traversal and malformed release bundle members', () => {
    const bundleRoot = 'project-space-machine-tools-darwin-arm64-v0.3.0';
    const traversal = runGeneratedInstaller([
      ...completeBundleEntries(bundleRoot),
      { name: '../escaped', contents: 'must not escape\n' }
    ]);
    const malformed = runGeneratedInstaller(
      completeBundleEntries(bundleRoot).filter(
        (entry) => !entry.name.endsWith('/release-manifest-signing-public-key.pem')
      )
    );

    expect(traversal.result.status).not.toBe(0);
    expect(existsSync(traversal.marker)).toBe(false);
    expect(existsSync(join(traversal.root, 'escaped'))).toBe(false);
    expect(malformed.result.status).not.toBe(0);
    expect(existsSync(malformed.marker)).toBe(false);
  });
});
