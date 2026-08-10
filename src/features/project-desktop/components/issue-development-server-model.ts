import type {
  ProjectSpaceRecord,
  WorktreeDevServerRecord
} from '@/shared/project-space-api';
import { resolvedProjectMachineId } from '../../../shared/project-machine-identity';
import { visibleTailscaleUrl } from './worktree-dev-server-model';

export interface IssueDevelopmentSurface {
  id: string;
  label: string;
  server: WorktreeDevServerRecord;
  url?: string;
}

export type IssueDevelopmentEmptyStateKind =
  | 'checking'
  | 'connector-offline'
  | 'no-connector'
  | 'no-declaration'
  | 'project-unavailable'
  | 'runtime-error';

export interface IssueDevelopmentEmptyState {
  kind: IssueDevelopmentEmptyStateKind;
  message: string;
}

export function issueDevelopmentEmptyState({
  connectorConfigured,
  error,
  hasProject,
  isChecking,
  isOnline,
  surfaceCount
}: {
  connectorConfigured: boolean;
  error?: string;
  hasProject: boolean;
  isChecking: boolean;
  isOnline: boolean;
  surfaceCount: number;
}): IssueDevelopmentEmptyState | undefined {
  if (surfaceCount > 0) return undefined;
  if (!connectorConfigured) {
    return {
      kind: 'no-connector',
      message: 'No connector is configured for this machine.'
    };
  }
  if (!isOnline) {
    return {
      kind: 'connector-offline',
      message: 'Connector is offline.'
    };
  }
  if (!hasProject) {
    return {
      kind: 'project-unavailable',
      message: 'Project is not registered in this environment.'
    };
  }
  if (error) {
    return { kind: 'runtime-error', message: error };
  }
  if (isChecking) {
    return { kind: 'checking', message: 'Checking servers…' };
  }
  return {
    kind: 'no-declaration',
    message: 'No development servers are declared for this worktree.'
  };
}

function basename(path: string) {
  return path.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
}

export function findDesignSpaceProject(
  projects: ProjectSpaceRecord[],
  machineId: string,
  localMachineId: string
) {
  return projects.find((project) => {
    if (project.kind === 'github' || resolvedProjectMachineId(project, localMachineId) !== machineId) {
      return false;
    }
    return project.name.toLowerCase() === 'design-space' || basename(project.rootPath) === 'design-space';
  });
}

function surfaceDefinition(server: WorktreeDevServerRecord, isDesignSpace: boolean) {
  if (isDesignSpace) {
    return server.serverId === 'dev'
      ? { id: 'design-space', label: 'Design Space', path: '/' }
      : undefined;
  }
  if (server.serverId === 'dev') return { id: 'app', label: 'App', path: '/' };
  if (server.serverId === 'docs') return { id: 'docs', label: 'Docs', path: '/' };
  if (server.serverId === 'prototype-desktop') {
    return { id: 'prototype', label: 'Prototype', path: '/prototype/desktop/' };
  }
  if (server.serverId === 'prototype-mobile') {
    return { id: 'native-prototype', label: 'Native prototype', path: '/prototype/mobile/' };
  }
  return undefined;
}

function surfaceUrl(server: WorktreeDevServerRecord, path: string, now: number) {
  const baseUrl = visibleTailscaleUrl(server, now);
  return baseUrl ? new URL(path, baseUrl).toString() : undefined;
}

export function issueDevelopmentSurfaces(
  servers: WorktreeDevServerRecord[],
  options: { isDesignSpace?: boolean; now?: number } = {}
) {
  const now = options.now ?? Date.now();
  const surfaces = servers.flatMap<IssueDevelopmentSurface>((server) => {
    const definition = surfaceDefinition(server, options.isDesignSpace ?? false);
    if (!definition) return [];
    return [{
      id: definition.id,
      label: definition.label,
      server,
      url: surfaceUrl(server, definition.path, now)
    }];
  });

  const order = ['app', 'docs', 'prototype', 'native-prototype', 'design-space'];
  return surfaces.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
}
