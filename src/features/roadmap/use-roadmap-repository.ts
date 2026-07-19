import { useEffect, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type {
  GitHubCatalogRepository,
  GitHubCatalogResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { resolveProjectRepository } from '../project-desktop/components/project-main-model';

interface RoadmapRepositoryDiscovery {
  error: string;
  isLoading: boolean;
  projectId?: string;
  repository?: GitHubCatalogRepository;
}

export function roadmapRepositoryForProject(
  project: ProjectSpaceRecord,
  catalog: GitHubCatalogResult,
  repository?: GitHubCatalogRepository
) {
  return repository ?? resolveProjectRepository(project, catalog);
}

export function useRoadmapRepository(
  project: ProjectSpaceRecord,
  repository?: GitHubCatalogRepository
) {
  const [discovery, setDiscovery] = useState<RoadmapRepositoryDiscovery>({
    error: '',
    isLoading: false
  });
  useEffect(() => {
    if (repository || project.github) {
      setDiscovery({ error: '', isLoading: false });
      return;
    }
    let canceled = false;
    setDiscovery({ error: '', isLoading: true, projectId: project.id });
    projectSpaceClient.getGitHubCatalog()
      .then((catalog) => {
        if (!canceled) {
          setDiscovery({
            error: '',
            isLoading: false,
            projectId: project.id,
            repository: roadmapRepositoryForProject(project, catalog)
          });
        }
      })
      .catch((error) => {
        if (!canceled) {
          setDiscovery({
            error: error instanceof Error ? error.message : 'Could not discover the GitHub repository.',
            isLoading: false,
            projectId: project.id
          });
        }
      });
    return () => {
      canceled = true;
    };
  }, [project, repository]);

  if (repository) return { error: '', isLoading: false, repository };
  if (project.github) return { error: '', isLoading: false, repository: project.github };
  if (discovery.projectId !== project.id) return { error: '', isLoading: true, repository: undefined };
  return discovery;
}
