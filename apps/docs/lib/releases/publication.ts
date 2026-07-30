import type {
  ReleasePublication,
} from './types';
import type { DocsDeploymentIdentity } from '../deployment-identity';

const fullCommitPattern = /^[0-9a-f]{40}$/;

export type ReleasePublicationResult =
  | { ok: true; publication: ReleasePublication }
  | { error: string; ok: false };

export function parseReleasePublication(
  value: unknown,
  expectedVersion: string,
): ReleasePublicationResult {
  if (!isRecord(value)) {
    return invalid('Publication metadata must be an object.');
  }
  const tag = stringValue(value.tag);
  const version = stringValue(value.version);
  const commit = stringValue(value.commit)?.toLowerCase();
  const sourceRevision = stringValue(
    value.sourceRevision,
  )?.toLowerCase();
  const githubReleaseUrl = stringValue(value.githubReleaseUrl);
  const publishedAt = stringValue(value.publishedAt);
  const status = value.status;

  if (version !== expectedVersion || tag !== `v${expectedVersion}`) {
    return invalid(
      `Publication metadata does not identify v${expectedVersion}.`,
    );
  }
  if (
    !commit ||
    !sourceRevision ||
    !fullCommitPattern.test(commit) ||
    sourceRevision !== commit
  ) {
    return invalid(
      'Publication commit and Docs source revision must be the same full Git SHA.',
    );
  }
  if (
    !githubReleaseUrl ||
    githubReleaseUrl !==
      `https://github.com/DotNaos/project-space/releases/tag/v${expectedVersion}`
  ) {
    return invalid(
      'Publication metadata has an unexpected GitHub Release URL.',
    );
  }
  if (
    !publishedAt ||
    Number.isNaN(Date.parse(publishedAt))
  ) {
    return invalid('Publication metadata has an invalid publication date.');
  }
  if (
    status !== 'Latest' &&
    status !== 'Prerelease' &&
    status !== 'Published'
  ) {
    return invalid('Publication metadata has an invalid status.');
  }

  return {
    ok: true,
    publication: {
      commit,
      githubReleaseUrl,
      publishedAt,
      sourceRevision,
      status,
      tag,
      version,
    },
  };
}

export function publicationMatchesDeployment(
  publication: ReleasePublication,
  identity: DocsDeploymentIdentity,
) {
  if (identity.state !== 'production') return false;
  if (publication.status !== 'Latest') return true;
  return (
    identity.version === publication.version &&
    identity.commit === publication.sourceRevision
  );
}

function invalid(error: string): ReleasePublicationResult {
  return { error, ok: false };
}

function stringValue(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
