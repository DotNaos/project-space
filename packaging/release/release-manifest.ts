import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  canonicalConnectorRuntimeReleaseManifest,
  connectorRuntimeReleaseManifestSchema,
  isConnectorRuntimeReleaseManifest,
  resolveConnectorRuntimeReleaseArtifact,
  verifyConnectorRuntimeReleaseManifest,
  type ConnectorRuntimeReleaseArtifact,
  type ConnectorRuntimeReleaseManifest,
  type SignedConnectorRuntimeReleaseManifest
} from '../../server/connector-runtime-release-manifest';
import type { ConnectorRuntimeReleaseTarget } from '../../server/connector-runtime-maintenance-contract';

export const releaseManifestSchema = connectorRuntimeReleaseManifestSchema;

const semanticVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const commitPattern = /^[a-f0-9]{40}$/;
const maximumValidityDays = 365;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const runtimeCapabilities = ['runtime.restart', 'runtime.update'] as const;
const managedCodexCapabilities = [
  'codex.account.device-login.v1',
  'codex.runtime.v1',
  ...runtimeCapabilities
] as const;
const runtimeProtocolVersion = '2';

export type ReleaseTarget = ConnectorRuntimeReleaseTarget;
export type ReleaseManifestArtifact = ConnectorRuntimeReleaseArtifact;
export type ReleaseManifest = ConnectorRuntimeReleaseManifest;
export type SignedReleaseManifest = SignedConnectorRuntimeReleaseManifest;

interface PrepareReleaseManifestOptions {
  artifactsDirectory: string;
  releaseId: string;
  sourceCommit: string;
  sourceEpoch: number;
  validityDays?: number;
  version: string;
}

interface CreateReleaseManifestOptions extends PrepareReleaseManifestOptions {
  outputPath: string;
  privateKey: string;
  publicKeyOutputPath?: string;
}

interface WritePreparedReleaseManifestOptions extends PrepareReleaseManifestOptions {
  manifestOutputPath: string;
  payloadOutputPath: string;
}

interface AssembleSignedReleaseManifestOptions {
  manifestPath: string;
  outputPath: string;
  payloadPath: string;
  publicKey: string;
  signaturePath: string;
}

interface VerifyReleaseManifestOptions {
  artifactPath?: string;
  expectedReleaseId: string;
  manifestPath: string;
  now?: Date;
  publicKey: string;
  target: ReleaseTarget;
}

interface ExpectedArtifact {
  assetName: string;
  capabilities: string[];
  target: ReleaseTarget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('Canonical JSON accepts safe integers only.');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('Canonical JSON contains an unsupported value.');
}

async function sha256File(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function findNamedFile(root: string, filename: string): Promise<string> {
  const matches: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === filename) {
        matches.push(path);
      }
    }
  }
  await visit(root);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${filename} artifact, found ${matches.length}.`);
  }
  return matches[0]!;
}

function releaseKey(privateKey: string) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Release manifest signing key must be Ed25519.');
  }
  return key;
}

function expectedArtifacts(version: string): ExpectedArtifact[] {
  return [
    {
      assetName: `project-space-machine-tools-darwin-arm64-v${version}.tar.gz`,
      capabilities: [...managedCodexCapabilities],
      target: 'darwin-arm64'
    },
    {
      assetName: `project-space-machine-tools-linux-x64-v${version}.tar.gz`,
      capabilities: [...managedCodexCapabilities],
      target: 'linux-x64'
    },
    {
      assetName: 'project-space-machine-tools-windows-x64-setup.exe',
      capabilities: [],
      target: 'windows-x64'
    }
  ];
}

function artifactDownloadUrl(releaseId: string, assetName: string) {
  return `https://github.com/DotNaos/project-space/releases/download/${releaseId}/${assetName}`;
}

export async function prepareReleaseManifest(
  options: PrepareReleaseManifestOptions
): Promise<ReleaseManifest> {
  if (
    !semanticVersionPattern.test(options.version) ||
    options.releaseId !== `v${options.version}`
  ) {
    throw new Error('Release version and release ID must be matching exact semantic versions.');
  }
  if (!commitPattern.test(options.sourceCommit)) {
    throw new Error('Source commit must be a full SHA.');
  }
  if (!Number.isSafeInteger(options.sourceEpoch) || options.sourceEpoch < 0) {
    throw new Error('Source epoch must be a non-negative integer.');
  }
  const validityDays = options.validityDays ?? maximumValidityDays;
  if (
    !Number.isSafeInteger(validityDays) ||
    validityDays < 1 ||
    validityDays > maximumValidityDays
  ) {
    throw new Error(`Manifest validity must be between 1 and ${maximumValidityDays} days.`);
  }

  const bundleVersions = {
    connector: options.version,
    machineTools: options.version,
    projectCli: options.version
  };
  const artifacts: ReleaseManifestArtifact[] = [];
  for (const expected of expectedArtifacts(options.version)) {
    const path = await findNamedFile(options.artifactsDirectory, expected.assetName);
    const details = await stat(path);
    if (!details.isFile() || details.size <= 0) {
      throw new Error(`Release artifact ${expected.assetName} must be a non-empty file.`);
    }
    artifacts.push({
      assetName: expected.assetName,
      bundleVersions: { ...bundleVersions },
      capabilities: [...expected.capabilities],
      downloadUrl: artifactDownloadUrl(options.releaseId, expected.assetName),
      protocolVersion: runtimeProtocolVersion,
      sha256: await sha256File(path),
      sizeBytes: details.size,
      target: expected.target
    });
  }

  const issuedAt = new Date(options.sourceEpoch * 1_000);
  const expiresAt = new Date(issuedAt.getTime() + validityDays * millisecondsPerDay);
  const manifest: ReleaseManifest = {
    artifacts,
    buildId: options.sourceCommit,
    channel: 'stable',
    expiresAt: expiresAt.toISOString(),
    issuedAt: issuedAt.toISOString(),
    releaseId: options.releaseId,
    schema: releaseManifestSchema,
    source: 'managed',
    version: options.version
  };
  return manifest;
}

export function releaseManifestSigningPayload(manifest: ReleaseManifest) {
  return canonicalConnectorRuntimeReleaseManifest(manifest);
}

export async function writePreparedReleaseManifest(
  options: WritePreparedReleaseManifestOptions
) {
  const manifest = await prepareReleaseManifest(options);
  await Promise.all([
    writeFile(options.manifestOutputPath, `${canonicalJson(manifest)}\n`, { mode: 0o644 }),
    writeFile(options.payloadOutputPath, releaseManifestSigningPayload(manifest), {
      mode: 0o644
    })
  ]);
  return manifest;
}

export async function assembleSignedReleaseManifest(
  options: AssembleSignedReleaseManifestOptions
): Promise<SignedReleaseManifest> {
  const parsed: unknown = JSON.parse(await readFile(options.manifestPath, 'utf8'));
  if (!isConnectorRuntimeReleaseManifest(parsed)) {
    throw new Error('Prepared release manifest is invalid.');
  }
  const expectedPayload = Buffer.from(releaseManifestSigningPayload(parsed), 'utf8');
  const payload = await readFile(options.payloadPath);
  if (!payload.equals(expectedPayload)) {
    throw new Error('Prepared release manifest payload does not match the manifest.');
  }
  const signatureBytes = await readFile(options.signaturePath);
  if (signatureBytes.byteLength !== 64) {
    throw new Error('Release manifest signature must contain exactly 64 bytes.');
  }
  const envelope: SignedReleaseManifest = {
    manifest: parsed,
    signature: signatureBytes.toString('base64url')
  };
  verifyConnectorRuntimeReleaseManifest(envelope, options.publicKey, {
    now: Date.parse(parsed.issuedAt) + 1_000
  });
  await writeFile(options.outputPath, `${canonicalJson(envelope)}\n`, { mode: 0o644 });
  return envelope;
}

export async function createReleaseManifest(
  options: CreateReleaseManifestOptions
): Promise<SignedReleaseManifest> {
  const manifest = await prepareReleaseManifest(options);
  const privateKey = releaseKey(options.privateKey);
  const signature = sign(
    null,
    Buffer.from(releaseManifestSigningPayload(manifest), 'utf8'),
    privateKey
  ).toString('base64url');
  const envelope: SignedReleaseManifest = { manifest, signature };

  await writeFile(options.outputPath, `${canonicalJson(envelope)}\n`, { mode: 0o644 });
  if (options.publicKeyOutputPath) {
    const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' });
    await writeFile(options.publicKeyOutputPath, publicKey, { mode: 0o600 });
  }
  return envelope;
}

export async function verifyReleaseManifest(options: VerifyReleaseManifestOptions) {
  const signed: unknown = JSON.parse(await readFile(options.manifestPath, 'utf8'));
  const now = options.now?.getTime();
  if (now !== undefined && !Number.isFinite(now)) {
    throw new Error('Release manifest verification time is invalid.');
  }
  const manifest = verifyConnectorRuntimeReleaseManifest(signed, options.publicKey, {
    now
  });
  const artifact = resolveConnectorRuntimeReleaseArtifact(
    manifest,
    options.target,
    options.expectedReleaseId
  );

  if (options.artifactPath) {
    if (basename(options.artifactPath) !== artifact.assetName) {
      throw new Error('Release artifact filename does not match the manifest.');
    }
    const details = await stat(options.artifactPath);
    if (
      !details.isFile() ||
      details.size !== artifact.sizeBytes ||
      (await sha256File(options.artifactPath)) !== artifact.sha256
    ) {
      throw new Error('Release artifact failed its integrity check.');
    }
  }
  return { artifact, manifest };
}
