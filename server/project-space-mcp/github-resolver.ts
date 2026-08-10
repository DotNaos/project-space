import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';

export type McpGitHubResolverBackend = Pick<
  ProjectSpaceBackend,
  'getGitHubCatalog' | 'getGitHubRepositoryDetails'
>;

export async function resolveGitHubRepository(
  backend: McpGitHubResolverBackend,
  repositoryId: string
) {
  const catalog = await backend.getGitHubCatalog();
  const repository = catalog.status === 'connected'
    ? catalog.repositories.find((candidate) => (
        String(candidate.id) === repositoryId || candidate.fullName === repositoryId
      ))
    : undefined;
  return { catalog, repository };
}

export async function resolveGitHubTask(
  backend: McpGitHubResolverBackend,
  repositoryId: string,
  taskNumber: number
) {
  const { catalog, repository } = await resolveGitHubRepository(backend, repositoryId);
  if (!repository) return { catalog, details: undefined, repository, task: undefined };
  const details = await backend.getGitHubRepositoryDetails(repository.fullName);
  const task = details.status === 'connected'
    ? details.issues.find((candidate) => candidate.number === taskNumber)
    : undefined;
  return { catalog, details, repository, task };
}
