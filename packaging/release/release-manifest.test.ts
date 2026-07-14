import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createReleaseManifest, verifyReleaseManifest } from './release-manifest';

const version = '1.2.3';
const releaseId = `v${version}`;
const sourceCommit = 'a'.repeat(40);
const issuedAt = 1_700_000_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'project-release-manifest-'));
  const artifacts = join(root, 'artifacts');
  await Bun.write(join(artifacts, `project-space-machine-tools-darwin-arm64-v${version}.tar.gz`), 'darwin');
  await Bun.write(join(artifacts, `project-space-machine-tools-linux-x64-v${version}.tar.gz`), 'linux');
  await Bun.write(join(artifacts, 'project-space-machine-tools-windows-x64-setup.exe'), 'windows');
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  return { artifacts, privateKey, publicKey, root };
}

async function create(root: Awaited<ReturnType<typeof fixture>>, name = 'manifest.json') {
  const outputPath = join(root.root, name);
  await createReleaseManifest({
    artifactsDirectory: root.artifacts,
    outputPath,
    privateKey: root.privateKey,
    releaseId,
    sourceCommit,
    sourceEpoch: issuedAt,
    validityDays: 30,
    version
  });
  return outputPath;
}

describe('authenticated release manifest', () => {
  test('is deterministic and verifies an exact approved artifact', async () => {
    const root = await fixture();
    const first = await create(root, 'first.json');
    const second = await create(root, 'second.json');
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'));

    const artifactPath = join(
      root.artifacts,
      `project-space-machine-tools-darwin-arm64-v${version}.tar.gz`
    );
    const verified = await verifyReleaseManifest({
      architecture: 'arm64',
      artifactPath,
      expectedReleaseId: releaseId,
      manifestPath: first,
      now: new Date((issuedAt + 60) * 1_000),
      platform: 'darwin',
      publicKey: root.publicKey
    });
    expect(verified.artifact.bundleVersions).toEqual({
      approvalSigner: version,
      connector: version,
      project: version
    });
  });

  test('rejects tampered manifests and artifacts', async () => {
    const root = await fixture();
    const manifestPath = await create(root);
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    parsed.sourceCommit = 'b'.repeat(40);
    await writeFile(manifestPath, JSON.stringify(parsed));
    await expect(
      verifyReleaseManifest({
        architecture: 'x64',
        expectedReleaseId: releaseId,
        manifestPath,
        now: new Date((issuedAt + 60) * 1_000),
        platform: 'linux',
        publicKey: root.publicKey
      })
    ).rejects.toThrow('signature is invalid');

    const cleanManifest = await create(root, 'clean.json');
    const artifactPath = join(root.artifacts, `project-space-machine-tools-linux-x64-v${version}.tar.gz`);
    await writeFile(artifactPath, 'tampered');
    await expect(
      verifyReleaseManifest({
        architecture: 'x64',
        artifactPath,
        expectedReleaseId: releaseId,
        manifestPath: cleanManifest,
        now: new Date((issuedAt + 60) * 1_000),
        platform: 'linux',
        publicKey: root.publicKey
      })
    ).rejects.toThrow('integrity check');
  });

  test('rejects stale, wrong-release, and unsupported target requests', async () => {
    const root = await fixture();
    const manifestPath = await create(root);
    const base = {
      manifestPath,
      publicKey: root.publicKey
    };
    await expect(
      verifyReleaseManifest({
        ...base,
        architecture: 'arm64',
        expectedReleaseId: releaseId,
        now: new Date((issuedAt + 31 * 24 * 60 * 60) * 1_000),
        platform: 'darwin'
      })
    ).rejects.toThrow('stale');
    await expect(
      verifyReleaseManifest({
        ...base,
        architecture: 'arm64',
        expectedReleaseId: 'v1.2.4',
        now: new Date((issuedAt + 60) * 1_000),
        platform: 'darwin'
      })
    ).rejects.toThrow('approved release');
    await expect(
      verifyReleaseManifest({
        ...base,
        architecture: 'arm64',
        expectedReleaseId: releaseId,
        now: new Date((issuedAt + 60) * 1_000),
        platform: 'linux'
      })
    ).rejects.toThrow('does not support');
  });
});
