import {
  createPublicKey,
  KeyObject,
  verify as verifySignature
} from 'node:crypto';

import type { ConnectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';

export const connectorRuntimeReleaseManifestSchema =
  'project-space.connector-runtime-release/v1' as const;

export type ConnectorRuntimeReleaseChannel = 'beta' | 'stable';

export interface ConnectorRuntimeReleaseBundleVersions {
  connector: string;
  machineTools: string;
  projectCli: string;
}

export interface ConnectorRuntimeReleaseArtifact {
  assetName: string;
  bundleVersions: ConnectorRuntimeReleaseBundleVersions;
  capabilities: string[];
  downloadUrl: string;
  protocolVersion: string;
  sha256: string;
  sizeBytes: number;
  target: ConnectorRuntimeReleaseTarget;
}

export interface ConnectorRuntimeReleaseManifest {
  artifacts: ConnectorRuntimeReleaseArtifact[];
  buildId: string;
  channel: ConnectorRuntimeReleaseChannel;
  expiresAt: string;
  issuedAt: string;
  releaseId: string;
  schema: typeof connectorRuntimeReleaseManifestSchema;
  source: 'managed';
  version: string;
}

export interface SignedConnectorRuntimeReleaseManifest {
  manifest: ConnectorRuntimeReleaseManifest;
  signature: string;
}

export type ConnectorRuntimeReleaseManifestErrorCode =
  | 'expired'
  | 'future-issued'
  | 'invalid-key'
  | 'invalid-schema'
  | 'invalid-signature'
  | 'invalid-validity'
  | 'release-mismatch'
  | 'unsupported-target';

export class ConnectorRuntimeReleaseManifestError extends Error {
  constructor(
    readonly code: ConnectorRuntimeReleaseManifestErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ConnectorRuntimeReleaseManifestError';
  }
}

const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const buildIdPattern = /^[0-9a-f]{40}$/;
const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const assetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/;
const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const protocolVersionPattern = /^[1-9]\d{0,7}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const maximumArtifactBytes = 2 * 1024 * 1024 * 1024;
const maximumManifestLifetimeMs = 370 * 24 * 60 * 60_000;
const manifestClockSkewMs = 5 * 60_000;
const releaseTargets = new Set<ConnectorRuntimeReleaseTarget>([
  'darwin-arm64',
  'linux-x64',
  'windows-x64'
]);

function isCanonicalSignature(value: string) {
  if (!signaturePattern.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 64 && decoded.toString('base64url') === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    timestampPattern.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isDownloadUrl(
  value: unknown,
  releaseId: string,
  assetName: string
): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      url.pathname ===
        `/DotNaos/project-space/releases/download/${releaseId}/${assetName}`
    );
  } catch {
    return false;
  }
}

function isBundleVersions(value: unknown): value is ConnectorRuntimeReleaseBundleVersions {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['connector', 'machineTools', 'projectCli']) &&
    typeof value.connector === 'string' &&
    semanticVersionPattern.test(value.connector) &&
    typeof value.machineTools === 'string' &&
    semanticVersionPattern.test(value.machineTools) &&
    typeof value.projectCli === 'string' &&
    semanticVersionPattern.test(value.projectCli)
  );
}

function isCapabilities(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every(
      (capability) =>
        typeof capability === 'string' && capabilityPattern.test(capability)
    )
  ) {
    return false;
  }
  return (
    new Set(value).size === value.length &&
    value.every((capability, index) => index === 0 || value[index - 1]! < capability)
  );
}

function isArtifact(
  value: unknown,
  releaseId: string
): value is ConnectorRuntimeReleaseArtifact {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'assetName',
      'bundleVersions',
      'capabilities',
      'downloadUrl',
      'protocolVersion',
      'sha256',
      'sizeBytes',
      'target'
    ]) &&
    typeof value.assetName === 'string' &&
    assetNamePattern.test(value.assetName) &&
    !value.assetName.includes('..') &&
    isBundleVersions(value.bundleVersions) &&
    isCapabilities(value.capabilities) &&
    isDownloadUrl(value.downloadUrl, releaseId, value.assetName) &&
    typeof value.protocolVersion === 'string' &&
    protocolVersionPattern.test(value.protocolVersion) &&
    typeof value.sha256 === 'string' &&
    digestPattern.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) &&
    Number(value.sizeBytes) > 0 &&
    Number(value.sizeBytes) <= maximumArtifactBytes &&
    releaseTargets.has(value.target as ConnectorRuntimeReleaseTarget)
  );
}

export function isConnectorRuntimeReleaseManifest(
  value: unknown
): value is ConnectorRuntimeReleaseManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifacts',
      'buildId',
      'channel',
      'expiresAt',
      'issuedAt',
      'releaseId',
      'schema',
      'source',
      'version'
    ]) ||
    value.schema !== connectorRuntimeReleaseManifestSchema ||
    typeof value.buildId !== 'string' ||
    !buildIdPattern.test(value.buildId) ||
    (value.channel !== 'stable' && value.channel !== 'beta') ||
    value.source !== 'managed' ||
    typeof value.releaseId !== 'string' ||
    !releaseIdPattern.test(value.releaseId) ||
    value.releaseId.toLowerCase() === 'latest' ||
    typeof value.version !== 'string' ||
    !semanticVersionPattern.test(value.version) ||
    !isTimestamp(value.issuedAt) ||
    !isTimestamp(value.expiresAt) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length === 0 ||
    value.artifacts.length > releaseTargets.size ||
    !value.artifacts.every((artifact) =>
      isArtifact(artifact, value.releaseId as string)
    )
  ) {
    return false;
  }

  const targets = value.artifacts.map((artifact) => artifact.target);
  return new Set(targets).size === targets.length;
}

function parseSignedManifest(value: unknown): SignedConnectorRuntimeReleaseManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['manifest', 'signature']) ||
    !isConnectorRuntimeReleaseManifest(value.manifest) ||
    typeof value.signature !== 'string' ||
    !isCanonicalSignature(value.signature)
  ) {
    throw new ConnectorRuntimeReleaseManifestError(
      'invalid-schema',
      'The connector runtime release manifest is invalid.'
    );
  }
  return {
    manifest: value.manifest,
    signature: value.signature
  };
}

export function canonicalConnectorRuntimeReleaseManifest(
  manifest: ConnectorRuntimeReleaseManifest
) {
  if (!isConnectorRuntimeReleaseManifest(manifest)) {
    throw new ConnectorRuntimeReleaseManifestError(
      'invalid-schema',
      'The connector runtime release manifest is invalid.'
    );
  }
  return canonicalJson(manifest);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
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
  throw new ConnectorRuntimeReleaseManifestError(
    'invalid-schema',
    'The connector runtime release manifest contains a non-canonical value.'
  );
}

export interface VerifyConnectorRuntimeReleaseManifestOptions {
  now?: number;
}

export function verifyConnectorRuntimeReleaseManifest(
  value: unknown,
  dedicatedPublicKey: Buffer | KeyObject | string,
  options: VerifyConnectorRuntimeReleaseManifestOptions = {}
): ConnectorRuntimeReleaseManifest {
  const signed = parseSignedManifest(value);
  let publicKey: KeyObject;
  try {
    publicKey =
      dedicatedPublicKey instanceof KeyObject
        ? dedicatedPublicKey
        : createPublicKey(dedicatedPublicKey);
  } catch {
    throw new ConnectorRuntimeReleaseManifestError(
      'invalid-key',
      'The connector runtime release verification key is invalid.'
    );
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new ConnectorRuntimeReleaseManifestError(
      'invalid-key',
      'The connector runtime release verification key must be Ed25519.'
    );
  }

  const valid = verifySignature(
    null,
    Buffer.from(canonicalConnectorRuntimeReleaseManifest(signed.manifest), 'utf8'),
    publicKey,
    Buffer.from(signed.signature, 'base64url')
  );
  if (!valid) {
    throw new ConnectorRuntimeReleaseManifestError(
      'invalid-signature',
      'The connector runtime release manifest signature is invalid.'
    );
  }

  const now = options.now ?? Date.now();
  const issuedAt = Date.parse(signed.manifest.issuedAt);
  const expiresAt = Date.parse(signed.manifest.expiresAt);
  if (issuedAt > now + manifestClockSkewMs) {
    throw new ConnectorRuntimeReleaseManifestError(
      'future-issued',
      'The connector runtime release manifest was issued in the future.'
    );
  }
  if (expiresAt <= now) {
    throw new ConnectorRuntimeReleaseManifestError(
      'expired',
      'The connector runtime release manifest has expired.'
    );
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maximumManifestLifetimeMs) {
    throw new ConnectorRuntimeReleaseManifestError(
      'invalid-validity',
      'The connector runtime release manifest validity period is invalid.'
    );
  }

  return structuredClone(signed.manifest);
}

export function resolveConnectorRuntimeReleaseArtifact(
  manifest: ConnectorRuntimeReleaseManifest,
  target: ConnectorRuntimeReleaseTarget,
  expectedReleaseId?: string
): ConnectorRuntimeReleaseArtifact {
  if (expectedReleaseId !== undefined && manifest.releaseId !== expectedReleaseId) {
    throw new ConnectorRuntimeReleaseManifestError(
      'release-mismatch',
      'The approved connector runtime release does not match the request.'
    );
  }
  const artifact = manifest.artifacts.find((candidate) => candidate.target === target);
  if (!artifact) {
    throw new ConnectorRuntimeReleaseManifestError(
      'unsupported-target',
      `The approved connector runtime release does not support ${target}.`
    );
  }
  return { ...artifact };
}
