import type { GitHubCatalogRepository, ProjectSpaceRecord } from './project-space-api';

export function projectChatProjectId(
  project: ProjectSpaceRecord,
  repository: GitHubCatalogRepository | undefined = project.github
) {
  if (repository) return `github:${repository.id}`;
  return `machine:${project.machineId ?? 'local'}:project:${project.id}`;
}
