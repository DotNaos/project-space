import type {
  AppMeta,
  ProjectDiscoveryResult,
  ProjectsState
} from '@/shared/project-space-api';

export interface ProjectDesktopBootstrapClient {
  getAppMeta(): Promise<AppMeta>;
  loadProjectDiscovery(): Promise<ProjectDiscoveryResult>;
  loadProjectsState(): Promise<ProjectsState>;
}

/** The initial primary desktop flow intentionally has no legacy Connector request. */
export function loadProjectDesktopBootstrap(client: ProjectDesktopBootstrapClient) {
  return Promise.all([
    client.loadProjectsState(),
    client.loadProjectDiscovery(),
    client.getAppMeta()
  ]);
}
