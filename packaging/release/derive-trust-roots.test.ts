import { afterEach, describe, expect, test } from 'bun:test';
import {
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

  test('keeps tagged manifest verification portable on the Linux publisher', async () => {
    const workflow = await readFile(
      join(import.meta.dir, '..', '..', '.github', 'workflows', 'release.yml'),
      'utf8'
    );
    expect(workflow).toContain('verification_now=$(bun -e');
    expect(workflow).toContain('--now "$verification_now"');
    expect(workflow).not.toContain('date -u -r');
  });
});
