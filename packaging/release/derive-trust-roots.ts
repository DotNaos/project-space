#!/usr/bin/env bun

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject
} from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const commandTrustRootFileName =
  'connector-command-signing-public-key.pem';
export const releaseTrustRootFileName =
  'release-manifest-signing-public-key.pem';

interface TrustRootInput {
  commandPrivateKeyBase64: string;
  outputDirectory: string;
  releasePrivateKeyBase64: string;
}

function privateEd25519Key(encoded: string, label: string) {
  const value = encoded.trim();
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is not valid base64.`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(Buffer.from(value, 'base64'));
  } catch {
    throw new Error(`${label} is not a private key.`);
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} must be a private Ed25519 key.`);
  }
  return key;
}

function publicPem(privateKey: KeyObject) {
  return createPublicKey(privateKey).export({
    format: 'pem',
    type: 'spki'
  }) as string;
}

async function writeTrustRoots(
  outputDirectory: string,
  commandPublicKey: string,
  releasePublicKey: string
) {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await Promise.all([
    writeFile(resolve(directory, commandTrustRootFileName), commandPublicKey, {
      flag: 'wx',
      mode: 0o644
    }),
    writeFile(resolve(directory, releaseTrustRootFileName), releasePublicKey, {
      flag: 'wx',
      mode: 0o644
    })
  ]);
}

export async function deriveReleaseTrustRoots(input: TrustRootInput) {
  const commandKey = privateEd25519Key(
    input.commandPrivateKeyBase64,
    'The connector command-signing key'
  );
  const releaseKey = privateEd25519Key(
    input.releasePrivateKeyBase64,
    'The release manifest-signing key'
  );
  await writeTrustRoots(
    input.outputDirectory,
    publicPem(commandKey),
    publicPem(releaseKey)
  );
}

export async function createValidationTrustRoots(outputDirectory: string) {
  const commandKey = generateKeyPairSync('ed25519').privateKey;
  const releaseKey = generateKeyPairSync('ed25519').privateKey;
  await writeTrustRoots(
    outputDirectory,
    publicPem(commandKey),
    publicPem(releaseKey)
  );
}

async function main() {
  const [operation, outputDirectory, ...extra] = process.argv.slice(2);
  if (!outputDirectory || extra.length > 0 ||
      (operation !== 'derive' && operation !== 'validation-only')) {
    throw new Error(
      'Usage: derive-trust-roots.ts <derive|validation-only> <output-directory>'
    );
  }
  if (operation === 'validation-only') {
    await createValidationTrustRoots(outputDirectory);
    return;
  }
  await deriveReleaseTrustRoots({
    commandPrivateKeyBase64:
      process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64 ?? '',
    outputDirectory,
    releasePrivateKeyBase64:
      process.env.PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64 ?? ''
  });
}

if (import.meta.main) {
  await main();
}
