import { readFileSync } from 'node:fs';

import type { ConnectorRuntimeApprovedReleaseSource } from './connector-runtime-maintenance-service';

export const connectorRuntimeReleaseManifestAsset = 'project-space-release-manifest.json';
const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const maximumManifestBytes = 2 * 1024 * 1024;
const defaultCacheMs = 5 * 60_000;
const defaultRequestTimeoutMs = 10_000;
export const connectorRuntimeBridgeReleaseId = 'v0.4.14';

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
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly releaseId: string,
    private readonly fetchManifest: ManifestFetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
    private readonly cacheMs = defaultCacheMs,
    private readonly requestTimeoutMs = defaultRequestTimeoutMs
  ) {
    connectorRuntimeReleaseManifestUrl(releaseId);
    if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 60 * 60_000) {
      throw new ConnectorRuntimeReleaseSourceError('invalid-configuration');
    }
    if (!Number.isSafeInteger(requestTimeoutMs) ||
        requestTimeoutMs < 1 || requestTimeoutMs > 60_000) {
      throw new ConnectorRuntimeReleaseSourceError('invalid-configuration');
    }
  }

  async loadApprovedManifest(requestedReleaseId?: string) {
    const releaseId = requestedReleaseId ?? this.releaseId;
    if (releaseId !== this.releaseId && releaseId !== connectorRuntimeBridgeReleaseId) {
      throw new ConnectorRuntimeReleaseSourceError('release-mismatch');
    }
    const now = this.now();
    const cached = this.cache.get(releaseId);
    if (cached && cached.expiresAt > now) {
      return structuredClone(cached.value);
    }

    const load = this.inFlight.get(releaseId) ?? this.startManifestLoad(now, releaseId);
    try {
      return structuredClone(await load);
    } finally {
      if (this.inFlight.get(releaseId) === load) this.inFlight.delete(releaseId);
    }
  }

  private startManifestLoad(now: number, releaseId: string) {
    const load = this.fetchApprovedManifest(now, releaseId);
    this.inFlight.set(releaseId, load);
    return load;
  }

  private async fetchApprovedManifest(now: number, releaseId: string) {
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        const error = new ConnectorRuntimeReleaseSourceError('unavailable');
        controller.abort(error);
        reject(error);
      }, this.requestTimeoutMs);
    });

    try {
      const value = await Promise.race([
        this.fetchManifestValue(controller.signal, releaseId),
        timeout
      ]);
      this.cache.set(releaseId, { expiresAt: now + this.cacheMs, value });
      return value;
    } catch {
      throw new ConnectorRuntimeReleaseSourceError('unavailable');
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }

  private async fetchManifestValue(signal: AbortSignal, releaseId: string) {
    const response = await this.fetchManifest(
      connectorRuntimeReleaseManifestUrl(releaseId),
      {
        cache: 'no-store',
        credentials: 'omit',
        method: 'GET',
        redirect: 'follow',
        signal
      }
    );
    if (!response.ok) throw new ConnectorRuntimeReleaseSourceError('unavailable');
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
    return value;
  }
}
