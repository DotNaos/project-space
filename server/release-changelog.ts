import {
  releaseChangelogSchema,
  type ReleaseChangelogEntry,
  type ReleaseChangelogResult
} from '../src/shared/release-changelog-api';
import {
  compareStableReleaseVersions,
  normalizeStableReleaseVersion
} from '../src/shared/release-version';

const repository = 'DotNaos/project-space';
const cacheTtlMs = 5 * 60 * 1_000;
const fetchTimeoutMs = 5_000;
const maximumBodyLength = 100_000;

interface CacheEntry {
  expiresAt: number;
  value: Promise<ReleaseChangelogResult>;
}

interface GitHubReleaseSource {
  body?: unknown;
  draft?: unknown;
  html_url?: unknown;
  name?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  tag_name?: unknown;
}

export interface ReleaseChangelogDependencies {
  fetch?: typeof fetch;
  githubToken?: string | null;
  now?: () => Date;
}

const cache = new Map<string, CacheEntry>();

export function releaseChangelogForVersion(
  version: string,
  dependencies: ReleaseChangelogDependencies = {}
) {
  const normalizedVersion = normalizeStableReleaseVersion(version);
  if (!normalizedVersion) {
    return Promise.resolve(emptyResult(version, dependencies.now?.() ?? new Date()));
  }

  if (dependencies.fetch || dependencies.now) {
    return loadReleaseChangelog(normalizedVersion, dependencies);
  }

  const now = Date.now();
  const cached = cache.get(normalizedVersion);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = loadReleaseChangelog(normalizedVersion).catch((error) => {
    cache.delete(normalizedVersion);
    throw error;
  });
  cache.set(normalizedVersion, { expiresAt: now + cacheTtlMs, value });
  return value;
}

export async function loadReleaseChangelog(
  currentVersion: string,
  dependencies: ReleaseChangelogDependencies = {}
): Promise<ReleaseChangelogResult> {
  const normalizedVersion = normalizeStableReleaseVersion(currentVersion);
  const now = dependencies.now?.() ?? new Date();
  if (!normalizedVersion) return emptyResult(currentVersion, now);

  const fetchRelease = dependencies.fetch ?? fetch;
  const githubToken = githubAuthorizationToken(
    dependencies.githubToken === undefined
      ? process.env.GITHUB_TOKEN
      : dependencies.githubToken
  );
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'project-space',
    'x-github-api-version': '2022-11-28'
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  const response = await fetchRelease(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    {
      headers,
      signal: AbortSignal.timeout(fetchTimeoutMs)
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub release history is unavailable (${response.status}).`);
  }

  const source: unknown = await response.json();
  if (!Array.isArray(source)) {
    throw new Error('GitHub returned invalid release history.');
  }

  const releases = source
    .map(parsePublishedRelease)
    .filter((entry): entry is ReleaseChangelogEntry => Boolean(entry))
    .filter((entry) => compareStableReleaseVersions(entry.version, normalizedVersion) <= 0)
    .sort((left, right) => compareStableReleaseVersions(right.version, left.version));

  return {
    checkedAt: now.toISOString(),
    currentReleaseAvailable: releases.some(
      (release) => release.version === normalizedVersion
    ),
    currentVersion: normalizedVersion,
    releases,
    schema: releaseChangelogSchema
  };
}

function parsePublishedRelease(value: unknown): ReleaseChangelogEntry | undefined {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false) {
    return undefined;
  }

  const tag = stringValue(value.tag_name);
  const version = tag ? normalizeStableReleaseVersion(tag) : undefined;
  const publishedAt = stringValue(value.published_at);
  const url = stringValue(value.html_url);
  if (
    !tag ||
    !version ||
    tag !== `v${version}` ||
    !publishedAt ||
    !isRealDate(publishedAt) ||
    url !== `https://github.com/${repository}/releases/tag/${tag}`
  ) {
    return undefined;
  }

  const releaseName = stringValue(value.name);
  return {
    body: cleanReleaseBody(stringValue(value.body) ?? ''),
    name: releaseName && releaseName !== tag
      ? releaseName.slice(0, 200)
      : `Project Space ${tag}`,
    publishedAt: new Date(publishedAt).toISOString(),
    tag,
    url,
    version
  };
}

function cleanReleaseBody(body: string) {
  return body
    .slice(0, maximumBodyLength)
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function emptyResult(version: string, now: Date): ReleaseChangelogResult {
  return {
    checkedAt: now.toISOString(),
    currentReleaseAvailable: false,
    currentVersion: normalizeStableReleaseVersion(version) ?? (version.trim() || 'unknown'),
    releases: [],
    schema: releaseChangelogSchema
  };
}

function stringValue(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function githubAuthorizationToken(value: unknown) {
  const token = stringValue(value);
  return token && !/[\r\n]/.test(token) ? token : undefined;
}

function isRealDate(value: string) {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf());
}

function isRecord(value: unknown): value is GitHubReleaseSource & Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
