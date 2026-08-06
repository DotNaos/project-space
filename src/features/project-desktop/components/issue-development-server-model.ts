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
