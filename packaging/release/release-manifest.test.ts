import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { verifyConnectorRuntimeReleaseManifest } from '../../server/connector-runtime-release-manifest';
import {
  createReleaseManifest,
  releaseManifestSchema,
  verifyReleaseManifest,
  type ReleaseTarget
} from './release-manifest';

const version = '1.2.3';
const releaseId = `v${version}`;
const sourceCommit = 'a'.repeat(40);
const issuedAt = 1_700_000_000;
const secondsPerDay = 24 * 60 * 60;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'project-release-manifest-'));
  const artifacts = join(root, 'artifacts');
  await Bun.write(
    join(artifacts, `project-space-machine-tools-darwin-arm64-v${version}.tar.gz`),
    'darwin'
  );
  await Bun.write(
    join(artifacts, `project-space-machine-tools-linux-x64-v${version}.tar.gz`),
    'linux'
  );
  await Bun.write(
    join(artifacts, 'project-space-machine-tools-windows-x64-setup.exe'),
    'windows'
  );
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  return { artifacts, privateKey, publicKey, root };
}

async function create(
  root: Awaited<ReturnType<typeof fixture>>,
  name = 'manifest.json',
  validityDays = 7
) {
  const outputPath = join(root.root, name);
  await createReleaseManifest({
    artifactsDirectory: root.artifacts,
    outputPath,
    privateKey: root.privateKey,
    releaseId,
    sourceCommit,
    sourceEpoch: issuedAt,
    validityDays,
    version
  });
  return outputPath;
}

describe('authenticated connector runtime release manifest', () => {
  test('creates and verifies an exact target through the release CLI', async () => {
    const root = await fixture();
    const manifestPath = join(root.root, 'cli-manifest.json');
    const publicKeyPath = join(root.root, 'cli-public-key.pem');
    const cliPath = join(import.meta.dir, 'release-manifest-cli.ts');
    const createProcess = Bun.spawn(
      [
        process.execPath,
        cliPath,
        'create',
        '--artifacts-dir',
        root.artifacts,
        '--version',
        version,
        '--release-id',
        releaseId,
        '--commit',
        sourceCommit,
        '--source-epoch',
        String(issuedAt),
        '--validity-days',
        '7',
        '--output',
        manifestPath,
        '--public-key-output',
        publicKeyPath
      ],
      {
        env: {
          ...process.env,
          PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64: Buffer.from(
            root.privateKey,
            'utf8'
          ).toString('base64')
        },
        stderr: 'pipe'
      }
    );
    expect(await createProcess.exited).toBe(0);
    expect(await new Response(createProcess.stderr).text()).toBe('');

    const artifactPath = join(
      root.artifacts,
      `project-space-machine-tools-linux-x64-v${version}.tar.gz`
    );
    const verifyProcess = Bun.spawn(
      [
        process.execPath,
        cliPath,
        'verify',
        '--manifest',
        manifestPath,
        '--public-key',
        publicKeyPath,
        '--target',
        'linux-x64',
        '--release-id',
        releaseId,
        '--artifact',
        artifactPath,
        '--now',
        new Date((issuedAt + 60) * 1_000).toISOString()
      ],
      { stderr: 'pipe' }
    );
    expect(await verifyProcess.exited).toBe(0);
    expect(await new Response(verifyProcess.stderr).text()).toBe('');
  });

  test('prepares a deterministic payload and assembles an externally signed envelope', async () => {
    const root = await fixture();
    const manifestPath = join(root.root, 'prepared-manifest.json');
    const payloadPath = join(root.root, 'prepared-payload.bin');
    const signaturePath = join(root.root, 'prepared-signature.bin');
    const outputPath = join(root.root, 'assembled-manifest.json');
    const publicKeyPath = join(root.root, 'release-public-key.pem');
    const cliPath = join(import.meta.dir, 'release-manifest-cli.ts');
    const prepareProcess = Bun.spawn(
      [
        process.execPath,
        cliPath,
        'prepare',
        '--artifacts-dir',
        root.artifacts,
        '--version',
        version,
        '--release-id',
        releaseId,
        '--commit',
        sourceCommit,
        '--source-epoch',
        String(issuedAt),
        '--validity-days',
        '7',
        '--manifest-output',
        manifestPath,
        '--payload-output',
        payloadPath
      ],
      { stderr: 'pipe' }
    );
    expect(await prepareProcess.exited).toBe(0);
    expect(await new Response(prepareProcess.stderr).text()).toBe('');

    const payload = await readFile(payloadPath);
    await writeFile(signaturePath, sign(null, payload, root.privateKey));
    await writeFile(publicKeyPath, root.publicKey);
    const assembleProcess = Bun.spawn(
      [
        process.execPath,
        cliPath,
        'assemble',
        '--manifest',
        manifestPath,
        '--payload',
        payloadPath,
        '--signature',
        signaturePath,
        '--public-key',
        publicKeyPath,
        '--output',
        outputPath
      ],
      { stderr: 'pipe' }
    );
    expect(await assembleProcess.exited).toBe(0);
    expect(await new Response(assembleProcess.stderr).text()).toBe('');
    const assembled = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(assembled.manifest.releaseId).toBe(releaseId);
    expect(assembled.signature).toBe(
      sign(null, payload, root.privateKey).toString('base64url')
    );

    await writeFile(payloadPath, `${payload.toString('utf8')}\n`);
    const tamperedProcess = Bun.spawn(
      [
        process.execPath,
        cliPath,
        'assemble',
        '--manifest',
        manifestPath,
        '--payload',
        payloadPath,
        '--signature',
        signaturePath,
        '--public-key',
        publicKeyPath,
        '--output',
        outputPath
      ],
      { stderr: 'pipe' }
    );
    expect(await tamperedProcess.exited).toBe(1);
    expect(await new Response(tamperedProcess.stderr).text()).toContain(
      'payload does not match'
    );

    await writeFile(payloadPath, payload);
    await writeFile(signaturePath, Buffer.alloc(63));
    const shortSignatureProcess = Bun.spawn(
      [
        process.execPath,
        cliPath,
        'assemble',
        '--manifest',
        manifestPath,
        '--payload',
        payloadPath,
        '--signature',
        signaturePath,
        '--public-key',
        publicKeyPath,
        '--output',
        outputPath
      ],
      { stderr: 'pipe' }
    );
    expect(await shortSignatureProcess.exited).toBe(1);
    expect(await new Response(shortSignatureProcess.stderr).text()).toContain(
      'exactly 64 bytes'
    );

    await writeFile(signaturePath, Buffer.alloc(64));
    const wrongSignatureProcess = Bun.spawn(
      [
        process.execPath,
        cliPath,
        'assemble',
        '--manifest',
        manifestPath,
        '--payload',
        payloadPath,
        '--signature',
        signaturePath,
        '--public-key',
        publicKeyPath,
        '--output',
        outputPath
      ],
      { stderr: 'pipe' }
    );
    expect(await wrongSignatureProcess.exited).toBe(1);
    expect(await new Response(wrongSignatureProcess.stderr).text()).toContain(
      'signature is invalid'
    );
  });

  test('is deterministic and is accepted by the runtime consumer', async () => {
    const root = await fixture();
    const first = await create(root, 'first.json');
    const second = await create(root, 'second.json');
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'));

    const envelope = JSON.parse(await readFile(first, 'utf8'));
    expect(Object.keys(envelope).sort()).toEqual(['manifest', 'signature']);
    const consumed = verifyConnectorRuntimeReleaseManifest(envelope, root.publicKey, {
      now: (issuedAt + 60) * 1_000
    });
    expect(consumed).toMatchObject({
      buildId: sourceCommit,
      channel: 'stable',
      releaseId,
      schema: releaseManifestSchema,
      source: 'managed',
      version
    });
    expect(consumed.artifacts.map((artifact) => artifact.target)).toEqual([
      'darwin-arm64',
      'linux-x64',
      'windows-x64'
    ]);
    expect(consumed.artifacts.map((artifact) => artifact.assetName)).toEqual([
      `project-space-machine-tools-darwin-arm64-v${version}.tar.gz`,
      `project-space-machine-tools-linux-x64-v${version}.tar.gz`,
      'project-space-machine-tools-windows-x64-setup.exe'
    ]);
    for (const artifact of consumed.artifacts) {
      expect(artifact.bundleVersions).toEqual({
        connector: version,
        machineTools: version,
        projectCli: version
      });
      expect(artifact.capabilities).toEqual(
        artifact.target === 'windows-x64'
            ? []
            : artifact.target === 'linux-x64'
            ? [
                'codex.account.device-login.v1',
                'codex.runtime.v1',
                'runtime.restart',
                'runtime.update'
              ]
            : ['runtime.restart', 'runtime.update']
      );
      expect(artifact.protocolVersion).toBe('2');
      expect(artifact.downloadUrl).toBe(
        `https://github.com/DotNaos/project-space/releases/download/${releaseId}/${artifact.assetName}`
      );
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test('defaults published manifests to a 365-day validity window', async () => {
    const root = await fixture();
    const outputPath = join(root.root, 'published.json');
    const envelope = await createReleaseManifest({
      artifactsDirectory: root.artifacts,
      outputPath,
      privateKey: root.privateKey,
      releaseId,
      sourceCommit,
      sourceEpoch: issuedAt,
      version
    });
    expect(Date.parse(envelope.manifest.expiresAt) - Date.parse(envelope.manifest.issuedAt)).toBe(
      365 * secondsPerDay * 1_000
    );
  });

  test('verifies the exact approved artifact for every release target', async () => {
    const root = await fixture();
    const manifestPath = await create(root);
    const targets: Array<{ assetName: string; target: ReleaseTarget }> = [
      {
        assetName: `project-space-machine-tools-darwin-arm64-v${version}.tar.gz`,
        target: 'darwin-arm64'
      },
      {
        assetName: `project-space-machine-tools-linux-x64-v${version}.tar.gz`,
        target: 'linux-x64'
      },
      {
        assetName: 'project-space-machine-tools-windows-x64-setup.exe',
        target: 'windows-x64'
      }
    ];
    for (const expected of targets) {
      const verified = await verifyReleaseManifest({
        artifactPath: join(root.artifacts, expected.assetName),
        expectedReleaseId: releaseId,
        manifestPath,
        now: new Date((issuedAt + 60) * 1_000),
        publicKey: root.publicKey,
        target: expected.target
      });
      expect(verified.artifact.assetName).toBe(expected.assetName);
      expect(verified.artifact.target).toBe(expected.target);
    }
  });

  test('rejects tampered manifests and artifacts', async () => {
    const root = await fixture();
    const manifestPath = await create(root);
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    parsed.manifest.buildId = 'b'.repeat(40);
    await writeFile(manifestPath, JSON.stringify(parsed));
    await expect(
      verifyReleaseManifest({
        expectedReleaseId: releaseId,
        manifestPath,
        now: new Date((issuedAt + 60) * 1_000),
        publicKey: root.publicKey,
        target: 'linux-x64'
      })
    ).rejects.toThrow('signature is invalid');

    const cleanManifest = await create(root, 'clean.json');
    const artifactPath = join(
      root.artifacts,
      `project-space-machine-tools-linux-x64-v${version}.tar.gz`
    );
    await writeFile(artifactPath, 'tampered');
    await expect(
      verifyReleaseManifest({
        artifactPath,
        expectedReleaseId: releaseId,
        manifestPath: cleanManifest,
        now: new Date((issuedAt + 60) * 1_000),
        publicKey: root.publicKey,
        target: 'linux-x64'
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
        expectedReleaseId: releaseId,
        now: new Date((issuedAt + 8 * secondsPerDay) * 1_000),
        target: 'darwin-arm64'
      })
    ).rejects.toThrow('expired');
    await expect(
      verifyReleaseManifest({
        ...base,
        expectedReleaseId: 'v1.2.4',
        now: new Date((issuedAt + 60) * 1_000),
        target: 'darwin-arm64'
      })
    ).rejects.toThrow('does not match');
    await expect(
      verifyReleaseManifest({
        ...base,
        expectedReleaseId: releaseId,
        now: new Date((issuedAt + 60) * 1_000),
        target: 'linux-arm64' as ReleaseTarget
      })
    ).rejects.toThrow('does not support');
  });
});
