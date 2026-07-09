import type { GitHubCatalogRepository } from '../../../shared/project-space-api';

export function normalizeRouteKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function routeProjectKeys(projectId: string) {
  const raw = projectId.trim();
  const withoutGitHubPrefix = raw.startsWith('github:') ? raw.slice('github:'.length) : raw;
  const withoutMachinePrefix = withoutGitHubPrefix.includes(':')
    ? withoutGitHubPrefix.split(':').pop() ?? withoutGitHubPrefix
    : withoutGitHubPrefix;
  const keys = new Set<string>();

  for (const candidate of [raw, withoutGitHubPrefix, withoutMachinePrefix]) {
    const normalized = normalizeRouteKey(candidate);

    if (!normalized) {
      continue;
    }

    keys.add(normalized);

    if (normalized.includes('__')) {
      keys.add(normalized.replaceAll('__', '/'));
      for (const part of normalized.split('__')) {
        if (part) {
          keys.add(part);
        }
      }
    }

    if (normalized.includes('/')) {
      const repoName = normalized.split('/').filter(Boolean).pop();
      if (repoName) {
        keys.add(repoName);
      }
    }
  }

  return keys;
}

export function routeProjectIdMatchesRepository(
  projectId: string,
  repo: GitHubCatalogRepository
) {
  const keys = routeProjectKeys(projectId);
  const repoFullName = normalizeRouteKey(repo.fullName);
  const repoName = normalizeRouteKey(repo.name);
  const repoSlug = repoFullName.replaceAll('/', '__');

  return keys.has(repoFullName) || keys.has(repoName) || keys.has(repoSlug);
}

export function shouldPreserveUnresolvedProjectRoute({
  githubCatalogCheckedAt,
  isGitHubRefreshing,
  projectId,
  routeProjectResolved
}: {
  githubCatalogCheckedAt: string;
  isGitHubRefreshing: boolean;
  projectId: string | undefined;
  routeProjectResolved: boolean;
}) {
  return Boolean(
    projectId &&
      !routeProjectResolved &&
      (!githubCatalogCheckedAt || isGitHubRefreshing)
  );
}
