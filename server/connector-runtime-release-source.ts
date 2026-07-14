import { readFileSync } from 'node:fs';

import type { ConnectorRuntimeApprovedReleaseSource } from './connector-runtime-maintenance-service';

export const connectorRuntimeReleaseManifestAsset = 'project-space-release-manifest.json';
const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const maximumManifestBytes = 2 * 1024 * 1024;
const defaultCacheMs = 5 * 60_000;

export class ConnectorRuntimeReleaseSourceError extends Error {
  constructor(
    readonly code: 'invalid-configuration' | 'release-mismatch' | 'unavailable'
  ) {
    super('The approved connector runtime release is unavailable.');
    this.name = 'ConnectorRuntimeReleaseSourceError';
  }
}

export function configuredConnectorRuntimeReleasePublicKey(
  environment: NodeJS.ProcessEnv = process.env
) {
  const encoded = environment.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64?.trim();
  if (encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
    if (decoded.includes('BEGIN PUBLIC KEY')) return decoded;
  }
  const inline = environment.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY?.trim();
  if (inline) return inline;
  const path = environment.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_FILE?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

export function configuredConnectorRuntimeReleaseId(
  environment: NodeJS.ProcessEnv = process.env
) {
  const value = (
    environment.PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID ??
    environment.PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION
  )?.trim();
  if (!value || !releaseIdPattern.test(value) || value.toLowerCase() === 'latest') {
    return undefined;
  }
  return value;
}

export function connectorRuntimeReleaseManifestUrl(releaseId: string) {
  if (!releaseIdPattern.test(releaseId) || releaseId.toLowerCase() === 'latest') {
    throw new ConnectorRuntimeReleaseSourceError('invalid-configuration');
  }
  return `https://github.com/DotNaos/project-space/releases/download/${releaseId}/${connectorRuntimeReleaseManifestAsset}`;
}

type ManifestFetch = (url: string, init: RequestInit) => Promise<Response>;

export class GitHubConnectorRuntimeReleaseSource
  implements ConnectorRuntimeApprovedReleaseSource {
  private cache?: { expiresAt: number; value: unknown };

  constructor(
    private readonly releaseId: string,
    private readonly fetchManifest: ManifestFetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
    private readonly cacheMs = defaultCacheMs
  ) {
    connectorRuntimeReleaseManifestUrl(releaseId);
    if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 60 * 60_000) {
      throw new ConnectorRuntimeReleaseSourceError('invalid-configuration');
    }
  }

  async loadApprovedManifest(requestedReleaseId?: string) {
    if (requestedReleaseId !== undefined && requestedReleaseId !== this.releaseId) {
      throw new ConnectorRuntimeReleaseSourceError('release-mismatch');
    }
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) {
      return structuredClone(this.cache.value);
    }

    const response = await this.fetchManifest(
      connectorRuntimeReleaseManifestUrl(this.releaseId),
      { cache: 'no-store', credentials: 'omit', method: 'GET', redirect: 'follow' }
    ).catch(() => undefined);
    if (!response?.ok) {
      throw new ConnectorRuntimeReleaseSourceError('unavailable');
    }
    const contentLength = response.headers.get('content-length');
    if ((contentLength !== null &&
          (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumManifestBytes))) {
      throw new ConnectorRuntimeReleaseSourceError('unavailable');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumManifestBytes) {
      throw new ConnectorRuntimeReleaseSourceError('unavailable');
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ConnectorRuntimeReleaseSourceError('unavailable');
    }
    this.cache = { expiresAt: now + this.cacheMs, value };
    return structuredClone(value);
  }
}
