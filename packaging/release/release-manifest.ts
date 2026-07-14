import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const releaseManifestSchema = 'project-space.release-manifest/v1';
const semanticVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const releaseIdPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export type ReleasePlatform = 'darwin' | 'linux' | 'windows';
export type ReleaseArchitecture = 'arm64' | 'x64';

export interface ReleaseManifestArtifact {
  architecture: ReleaseArchitecture;
  bundleVersions: {
    approvalSigner?: string;
    connector: string;
    project: string;
  };
  filename: string;
  format: 'inno-setup' | 'tar.gz';
  platform: ReleasePlatform;
  sha256: string;
  size: number;
}

export interface SignedReleaseManifest {
  artifacts: ReleaseManifestArtifact[];
  channel: 'stable';
  expiresAt: string;
  issuedAt: string;
  minimumUpdaterProtocol: 1;
  releaseId: string;
  schema: typeof releaseManifestSchema;
  signature: {
    algorithm: 'ed25519';
    keyId: string;
    value: string;
  };
  source: 'github-release';
  sourceCommit: string;
  version: string;
}

interface CreateReleaseManifestOptions {
  artifactsDirectory: string;
  outputPath: string;
  privateKey: string;
  publicKeyOutputPath?: string;
  releaseId: string;
  sourceCommit: string;
  sourceEpoch: number;
  validityDays?: number;
  version: string;
}

interface VerifyReleaseManifestOptions {
  architecture: ReleaseArchitecture;
  artifactPath?: string;
  expectedReleaseId: string;
  manifestPath: string;
  now?: Date;
  platform: ReleasePlatform;
  publicKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Canonical JSON accepts safe integers only.');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
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
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function findNamedFile(root: string, filename: string): Promise<string> {
  const matches: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === filename) matches.push(path);
    }
  }
  await visit(root);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${filename} artifact, found ${matches.length}.`);
  }
  return matches[0];
}

function releaseKey(privateKey: string) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Release manifest signing key must be Ed25519.');
  }
  return key;
}

function publicKeyId(key: KeyObject) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

function expectedArtifacts(version: string) {
  return [
    {
      architecture: 'arm64' as const,
      bundleVersions: { approvalSigner: version, connector: version, project: version },
      filename: `project-space-machine-tools-darwin-arm64-v${version}.tar.gz`,
      format: 'tar.gz' as const,
      platform: 'darwin' as const
    },
    {
      architecture: 'x64' as const,
      bundleVersions: { connector: version, project: version },
      filename: `project-space-machine-tools-linux-x64-v${version}.tar.gz`,
      format: 'tar.gz' as const,
      platform: 'linux' as const
    },
    {
      architecture: 'x64' as const,
      bundleVersions: { connector: version, project: version },
      filename: 'project-space-machine-tools-windows-x64-setup.exe',
      format: 'inno-setup' as const,
      platform: 'windows' as const
    }
  ];
}

export async function createReleaseManifest(options: CreateReleaseManifestOptions) {
  if (!semanticVersionPattern.test(options.version) || options.releaseId !== `v${options.version}`) {
    throw new Error('Release version and release ID must be matching exact semantic versions.');
  }
  if (!commitPattern.test(options.sourceCommit)) throw new Error('Source commit must be a full SHA.');
  if (!Number.isSafeInteger(options.sourceEpoch) || options.sourceEpoch < 0) {
    throw new Error('Source epoch must be a non-negative integer.');
  }
  const validityDays = options.validityDays ?? 365;
  if (!Number.isSafeInteger(validityDays) || validityDays < 1 || validityDays > 730) {
    throw new Error('Manifest validity must be between 1 and 730 days.');
  }

  const artifacts: ReleaseManifestArtifact[] = [];
  for (const expected of expectedArtifacts(options.version)) {
    const path = await findNamedFile(options.artifactsDirectory, expected.filename);
    const details = await stat(path);
    artifacts.push({
      ...expected,
      sha256: await sha256File(path),
      size: details.size
    });
  }

  const issuedAt = new Date(options.sourceEpoch * 1_000);
  const expiresAt = new Date(issuedAt.getTime() + validityDays * 24 * 60 * 60 * 1_000);
  const unsigned = {
    artifacts,
    channel: 'stable' as const,
    expiresAt: expiresAt.toISOString(),
    issuedAt: issuedAt.toISOString(),
    minimumUpdaterProtocol: 1 as const,
    releaseId: options.releaseId,
    schema: releaseManifestSchema,
    source: 'github-release' as const,
    sourceCommit: options.sourceCommit,
    version: options.version
  };
  const privateKey = releaseKey(options.privateKey);
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64url');
  const manifest: SignedReleaseManifest = {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: publicKeyId(privateKey),
      value: signature
    }
  };
  await writeFile(options.outputPath, `${canonicalJson(manifest)}\n`, { mode: 0o644 });
  if (options.publicKeyOutputPath) {
    const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' });
    await writeFile(options.publicKeyOutputPath, publicKey, { mode: 0o600 });
  }
  return manifest;
}

function parseArtifact(value: unknown): ReleaseManifestArtifact {
  if (!isRecord(value) || !hasExactKeys(value, [
    'architecture', 'bundleVersions', 'filename', 'format', 'platform', 'sha256', 'size'
  ])) throw new Error('Release manifest contains an invalid artifact.');
  if (!isRecord(value.bundleVersions) || !hasExactKeys(
    value.bundleVersions,
    value.platform === 'darwin'
      ? ['approvalSigner', 'connector', 'project']
      : ['connector', 'project']
  )) throw new Error('Release manifest contains invalid bundle versions.');
  const artifact = value as unknown as ReleaseManifestArtifact;
  if (!['darwin', 'linux', 'windows'].includes(artifact.platform) ||
      !['arm64', 'x64'].includes(artifact.architecture) ||
      !['tar.gz', 'inno-setup'].includes(artifact.format) ||
      !filenamePattern.test(artifact.filename) ||
      !digestPattern.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
      !semanticVersionPattern.test(artifact.bundleVersions.connector) ||
      !semanticVersionPattern.test(artifact.bundleVersions.project) ||
      (artifact.bundleVersions.approvalSigner !== undefined &&
        !semanticVersionPattern.test(artifact.bundleVersions.approvalSigner))) {
    throw new Error('Release manifest contains an invalid artifact value.');
  }
  return artifact;
}

function parseManifest(body: string): SignedReleaseManifest {
  const value: unknown = JSON.parse(body);
  if (!isRecord(value) || !hasExactKeys(value, [
    'artifacts', 'channel', 'expiresAt', 'issuedAt', 'minimumUpdaterProtocol', 'releaseId',
    'schema', 'signature', 'source', 'sourceCommit', 'version'
  ])) throw new Error('Release manifest has an invalid shape.');
  if (!isRecord(value.signature) ||
      !hasExactKeys(value.signature, ['algorithm', 'keyId', 'value']) ||
      value.signature.algorithm !== 'ed25519' ||
      typeof value.signature.keyId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(value.signature.keyId) ||
      typeof value.signature.value !== 'string' ||
      !/^[A-Za-z0-9_-]{86}$/.test(value.signature.value) ||
      !Array.isArray(value.artifacts)) {
    throw new Error('Release manifest signature or artifacts are invalid.');
  }
  const manifest = value as unknown as SignedReleaseManifest;
  manifest.artifacts = value.artifacts.map(parseArtifact);
  if (manifest.schema !== releaseManifestSchema || manifest.channel !== 'stable' ||
      manifest.source !== 'github-release' || manifest.minimumUpdaterProtocol !== 1 ||
      !semanticVersionPattern.test(manifest.version) ||
      !releaseIdPattern.test(manifest.releaseId) || manifest.releaseId !== `v${manifest.version}` ||
      !commitPattern.test(manifest.sourceCommit)) {
    throw new Error('Release manifest identity is invalid.');
  }
  const targets = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const target = `${artifact.platform}/${artifact.architecture}`;
    if (targets.has(target)) throw new Error('Release manifest contains a duplicate target.');
    targets.add(target);
  }
  return manifest;
}

export async function verifyReleaseManifest(options: VerifyReleaseManifestOptions) {
  const manifest = parseManifest(await readFile(options.manifestPath, 'utf8'));
  const publicKey = createPublicKey(options.publicKey);
  if (publicKey.asymmetricKeyType !== 'ed25519' || publicKeyId(publicKey) !== manifest.signature.keyId) {
    throw new Error('Release manifest signing key is not trusted.');
  }
  const { signature, ...unsigned } = manifest;
  if (!verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature.value, 'base64url'))) {
    throw new Error('Release manifest signature is invalid.');
  }

  const now = options.now ?? new Date();
  const issuedAt = new Date(manifest.issuedAt);
  const expiresAt = new Date(manifest.expiresAt);
  if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= issuedAt || issuedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error('Release manifest validity window is invalid.');
  }
  if (expiresAt <= now) throw new Error('Release manifest is stale.');
  if (manifest.releaseId !== options.expectedReleaseId) {
    throw new Error('Release manifest does not match the approved release.');
  }
  const artifact = manifest.artifacts.find(
    (entry) => entry.platform === options.platform && entry.architecture === options.architecture
  );
  if (!artifact) throw new Error('Release manifest does not support this platform and architecture.');
  if (options.artifactPath) {
    if (basename(options.artifactPath) !== artifact.filename) {
      throw new Error('Release artifact filename does not match the manifest.');
    }
    const details = await stat(options.artifactPath);
    if (details.size !== artifact.size || (await sha256File(options.artifactPath)) !== artifact.sha256) {
      throw new Error('Release artifact failed its integrity check.');
    }
  }
  return { artifact, manifest };
}
