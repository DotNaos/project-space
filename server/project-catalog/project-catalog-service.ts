import type { ProjectCliCatalogResult } from '../../src/shared/project-catalog-api';
import type {
  GitHubCatalogResult,
  ProjectDiscoveryResult
} from '../../src/shared/project-space-api';

function compareText(left: string, right: string) {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function buildProjectCliCatalog(
  catalog: GitHubCatalogResult,
  discovery: ProjectDiscoveryResult,
  callerMachineId: string
): ProjectCliCatalogResult {
  const localByRepository = new Map<string, Array<{ path: string; projectId: string }>>();
  for (const project of discovery.projects) {
    if (project.machineId !== callerMachineId || !project.github?.fullName) continue;
    const key = project.github.fullName.toLowerCase();
    const candidates = localByRepository.get(key) ?? [];
    candidates.push({ path: project.rootPath, projectId: project.id });
    localByRepository.set(key, candidates);
  }

  const projects = catalog.repositories.map((repository) => ({
    displayName: repository.name,
    id: `github:${repository.id}`,
    localCandidates: [...(localByRepository.get(repository.fullName.toLowerCase()) ?? [])]
      .sort((left, right) =>
        compareText(left.path, right.path) || compareText(left.projectId, right.projectId)
      ),
    repository: repository.fullName
  })).sort((left, right) =>
    compareText(left.repository, right.repository) || compareText(left.id, right.id)
  );

  return {
    account: {
      ...(catalog.auth?.login ? { login: catalog.auth.login } : {})
    },
    catalog: {
      ...(catalog.cache?.state ? { cacheState: catalog.cache.state } : {}),
      checkedAt: catalog.checkedAt,
      ...(catalog.cache?.lastUpdated ? { lastUpdated: catalog.cache.lastUpdated } : {}),
      ...(catalog.message ? { message: catalog.message } : {}),
      status: catalog.status
    },
    projects,
    schemaVersion: 1
  };
}
