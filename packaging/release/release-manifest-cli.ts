#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

import {
  assembleSignedReleaseManifest,
  createReleaseManifest,
  verifyReleaseManifest,
  writePreparedReleaseManifest,
  type ReleaseTarget
} from './release-manifest';

function usage(): never {
  console.error(`Usage:
  release-manifest-cli.ts create --artifacts-dir DIR --version X.Y.Z --release-id vX.Y.Z --commit SHA --source-epoch SECONDS --output FILE [--public-key-output FILE] [--validity-days DAYS]
  release-manifest-cli.ts prepare --artifacts-dir DIR --version X.Y.Z --release-id vX.Y.Z --commit SHA --source-epoch SECONDS --manifest-output FILE --payload-output FILE [--validity-days DAYS]
  release-manifest-cli.ts assemble --manifest FILE --payload FILE --signature FILE --public-key FILE --output FILE
  release-manifest-cli.ts verify --manifest FILE --public-key FILE --target TARGET --release-id ID [--artifact FILE] [--now ISO]

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
  if (command === 'prepare') {
    only(values, [
      '--artifacts-dir', '--commit', '--manifest-output', '--payload-output',
      '--release-id', '--source-epoch', '--validity-days', '--version'
    ]);
    await writePreparedReleaseManifest({
      artifactsDirectory: required(values, '--artifacts-dir'),
      manifestOutputPath: required(values, '--manifest-output'),
      payloadOutputPath: required(values, '--payload-output'),
      releaseId: required(values, '--release-id'),
      sourceCommit: required(values, '--commit'),
      sourceEpoch: Number(required(values, '--source-epoch')),
      validityDays: values.has('--validity-days') ? Number(values.get('--validity-days')) : undefined,
      version: required(values, '--version')
    });
    return;
  }
  if (command === 'assemble') {
    only(values, ['--manifest', '--output', '--payload', '--public-key', '--signature']);
    await assembleSignedReleaseManifest({
      manifestPath: required(values, '--manifest'),
      outputPath: required(values, '--output'),
      payloadPath: required(values, '--payload'),
      publicKey: await readFile(required(values, '--public-key'), 'utf8'),
      signaturePath: required(values, '--signature')
    });
    return;
  }
  if (command === 'verify') {
    only(values, [
      '--artifact', '--manifest', '--now', '--public-key', '--release-id', '--target'
    ]);
    await verifyReleaseManifest({
      artifactPath: values.get('--artifact'),
      expectedReleaseId: required(values, '--release-id'),
      manifestPath: required(values, '--manifest'),
      now: values.has('--now') ? new Date(required(values, '--now')) : undefined,
      publicKey: await readFile(required(values, '--public-key'), 'utf8'),
      target: required(values, '--target') as ReleaseTarget
    });
    return;
  }
  usage();
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
