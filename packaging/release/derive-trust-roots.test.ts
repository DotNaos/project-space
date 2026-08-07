import { afterEach, describe, expect, test } from 'bun:test';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject
} from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commandTrustRootFileName,
  deriveReleaseTrustRoots,
  releaseTrustRootFileName
} from './derive-trust-roots';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

function privateKeyBase64(key: KeyObject) {
  return Buffer.from(key.export({ format: 'pem', type: 'pkcs8' }) as string)
    .toString('base64');
}

function publicDer(key: KeyObject) {
  return createPublicKey(key).export({ format: 'der', type: 'spki' });
}

describe('release trust roots', () => {
  test('derives only the matching public Ed25519 roots', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'project-trust-roots-'));
    temporaryDirectories.push(outputDirectory);
    const commandKey = generateKeyPairSync('ed25519').privateKey;
    const releaseKey = generateKeyPairSync('ed25519').privateKey;

    await deriveReleaseTrustRoots({
      commandPrivateKeyBase64: privateKeyBase64(commandKey),
      outputDirectory,
      releasePrivateKeyBase64: privateKeyBase64(releaseKey)
    });

    const commandRoot = createPublicKey(await readFile(
      join(outputDirectory, commandTrustRootFileName)
    ));
    const releaseRoot = createPublicKey(await readFile(
      join(outputDirectory, releaseTrustRootFileName)
    ));
    expect(commandRoot.type).toBe('public');
    expect(commandRoot.asymmetricKeyType).toBe('ed25519');
    expect(commandRoot.export({ format: 'der', type: 'spki' }))
      .toEqual(publicDer(commandKey));
    expect(releaseRoot.export({ format: 'der', type: 'spki' }))
      .toEqual(publicDer(releaseKey));
  });

  test('rejects missing, malformed, and non-Ed25519 private keys', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'project-trust-roots-'));
    temporaryDirectories.push(outputDirectory);
    const releaseKey = generateKeyPairSync('ed25519').privateKey;
    const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const input = {
      commandPrivateKeyBase64: '',
      outputDirectory,
      releasePrivateKeyBase64: privateKeyBase64(releaseKey)
    };

    await expect(deriveReleaseTrustRoots(input)).rejects.toThrow('valid base64');
    await expect(deriveReleaseTrustRoots({
      ...input,
      commandPrivateKeyBase64: privateKeyBase64(rsaKey)
    })).rejects.toThrow('private Ed25519 key');
  });

  test('pins reviewed public roots without exposing private signing keys', async () => {
    const releaseWorkflow = await readFile(
      join(import.meta.dir, '..', '..', '.github', 'workflows', 'release.yml'),
      'utf8'
    );
    const trustWorkflow = await readFile(
      join(import.meta.dir, '..', '..', '.github', 'workflows', 'release-trust-roots.yml'),
      'utf8'
    );
    const pinnedRoots = [
      [
        commandTrustRootFileName,
        '502f8b9dbbabec58aa8d2c794c7c052d5974215e2180f9e47ed4d7cff4ee45c1'
      ],
      [
        releaseTrustRootFileName,
        'aff71d44e194f87e7e958296306059d3d5b55d7c369963b61d57627e03f4a451'
      ]
    ] as const;

    expect(releaseWorkflow).toContain('uses: ./.github/workflows/release-trust-roots.yml');
    expect(releaseWorkflow).toContain(
      'verification_now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
    );
    expect(releaseWorkflow).toContain('--now "$verification_now"');
    expect(releaseWorkflow).not.toContain('date -u -r');
    expect(trustWorkflow).not.toContain('github.ref_type');
    expect(trustWorkflow).not.toContain('Create disposable validation roots');
    expect(trustWorkflow).toContain(
      'Release tag must point at the exact queued merge.'
    );
    expect(trustWorkflow).toContain(
      'Queued release commit must be reachable from current main.'
    );

    for (const [fileName, expectedDigest] of pinnedRoots) {
      const bytes = await readFile(join(import.meta.dir, 'trust-roots', fileName));
      const pem = bytes.toString('utf8');
      const key = createPublicKey(bytes);
      expect(key.type).toBe('public');
      expect(key.asymmetricKeyType).toBe('ed25519');
      expect(pem).toMatch(
        /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/
      );
      expect(pem).not.toContain('PRIVATE KEY');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedDigest);
      expect(trustWorkflow).toContain(expectedDigest);
      expect(trustWorkflow).toContain(pem.split('\n')[1]!);
    }

    for (const forbidden of [
      '1password/load-secrets-action@',
      'OP_SERVICE_ACCOUNT_TOKEN',
      'PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64',
      'PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64',
      'derive-trust-roots.ts derive'
    ]) {
      expect(trustWorkflow).not.toContain(forbidden);
    }
  });
});
