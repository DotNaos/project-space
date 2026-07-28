import type { GitHubCatalogStatus } from './project-space-api';

export interface ProjectCliCatalogCandidate {
  path: string;
  projectId: string;
}

export interface ProjectCliCatalogProject {
  displayName: string;
  id: string;
  localCandidates: ProjectCliCatalogCandidate[];
  repository: string;
}

export interface ProjectCliCatalogResult {
  account: {
    login?: string;
  };
  catalog: {
    cacheState?: 'miss' | 'fresh' | 'stale' | 'refreshing' | 'refresh-failed';
    checkedAt: string;
    lastUpdated?: string;
    message?: string;
    status: GitHubCatalogStatus;
  };
  projects: ProjectCliCatalogProject[];
  schemaVersion: 1;
}
