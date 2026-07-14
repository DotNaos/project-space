#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

import {
  createReleaseManifest,
  verifyReleaseManifest,
  type ReleaseArchitecture,
  type ReleasePlatform
} from './release-manifest';

function usage(): never {
  console.error(`Usage:
  release-manifest-cli.ts create --artifacts-dir DIR --version X.Y.Z --release-id vX.Y.Z --commit SHA --source-epoch SECONDS --output FILE [--public-key-output FILE] [--validity-days DAYS]
  release-manifest-cli.ts verify --manifest FILE --public-key FILE --platform PLATFORM --architecture ARCH --release-id ID [--artifact FILE] [--now ISO]

Create reads PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64 from the environment.`);
  process.exit(64);
}

function flags(arguments_: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--') || values.has(name)) usage();
    values.set(name, value);
  }
  return values;
}

function required(values: Map<string, string>, name: string) {
  const value = values.get(name);
  if (!value) usage();
  return value;
}

function only(values: Map<string, string>, allowed: readonly string[]) {
  for (const name of values.keys()) if (!allowed.includes(name)) usage();
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const values = flags(arguments_);
  if (command === 'create') {
    only(values, [
      '--artifacts-dir', '--commit', '--output', '--public-key-output', '--release-id',
      '--source-epoch', '--validity-days', '--version'
    ]);
    const encodedKey = process.env.PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64?.trim();
    if (!encodedKey) throw new Error('Release manifest signing key is not configured.');
    await createReleaseManifest({
      artifactsDirectory: required(values, '--artifacts-dir'),
      outputPath: required(values, '--output'),
      privateKey: Buffer.from(encodedKey, 'base64').toString('utf8'),
      publicKeyOutputPath: values.get('--public-key-output'),
      releaseId: required(values, '--release-id'),
      sourceCommit: required(values, '--commit'),
      sourceEpoch: Number(required(values, '--source-epoch')),
      validityDays: values.has('--validity-days') ? Number(values.get('--validity-days')) : undefined,
      version: required(values, '--version')
    });
    return;
  }
  if (command === 'verify') {
    only(values, [
      '--architecture', '--artifact', '--manifest', '--now', '--platform', '--public-key',
      '--release-id'
    ]);
    await verifyReleaseManifest({
      architecture: required(values, '--architecture') as ReleaseArchitecture,
      artifactPath: values.get('--artifact'),
      expectedReleaseId: required(values, '--release-id'),
      manifestPath: required(values, '--manifest'),
      now: values.has('--now') ? new Date(required(values, '--now')) : undefined,
      platform: required(values, '--platform') as ReleasePlatform,
      publicKey: await readFile(required(values, '--public-key'), 'utf8')
    });
    return;
  }
  usage();
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
