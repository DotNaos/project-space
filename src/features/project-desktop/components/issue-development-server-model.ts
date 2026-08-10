import type {
  ProjectSpaceRecord,
  WorktreeDevServerRecord
} from '@/shared/project-space-api';
import type { WorktreeSetupResult } from '@/shared/worktree-action-api';
import { resolvedProjectMachineId } from '../../../shared/project-machine-identity';
import {
  devServerFreshnessMaxAgeMs,
  isFreshDevServerTimestamp,
  visibleTailscaleUrl
} from './worktree-dev-server-model';

export interface IssueDevelopmentSurface {
  id: string;
  isCurrent: boolean;
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

export type IssueDevelopmentSetupStateKind =
  | 'checking'
  | 'error'
  | 'failed'
  | 'ready'
  | 'required'
  | 'running';

export interface IssueDevelopmentSetupState {
  action?: 'retry' | 'run';
  blocksStart: boolean;
  kind: IssueDevelopmentSetupStateKind;
  message: string;
  setupStepId?: string;
}

export function issueDevelopmentSetupState({
  error,
  isChecking,
  result
}: {
  error?: string;
  isChecking: boolean;
  result?: WorktreeSetupResult;
}): IssueDevelopmentSetupState {
  if (error) {
    return { blocksStart: true, kind: 'error', message: error };
  }
  if (result?.lastError) {
    return { blocksStart: true, kind: 'error', message: result.lastError };
  }
  if (isChecking) {
    return { blocksStart: true, kind: 'checking', message: 'Checking setup…' };
  }
  if (result?.capability === 'unavailable') {
    return { blocksStart: false, kind: 'ready', message: 'No setup required.' };
  }
  if (result) {
    const setupStep = result.steps.find(
      (step) => step.state !== 'ready' && step.state !== 'running'
    );
    if (setupStep) {
      const shouldRetry = setupStep.state === 'failed' || setupStep.state === 'interrupted';
      return {
        action: shouldRetry ? 'retry' : 'run',
        blocksStart: true,
        kind: shouldRetry ? 'failed' : 'required',
        message: shouldRetry
          ? setupStep.lastError ?? result.lastError ?? 'Trusted setup did not complete.'
          : setupStep.state === 'stale'
            ? 'Setup is stale for this worktree.'
            : 'Setup is required before starting development servers.',
        setupStepId: setupStep.setupStepId
      };
    }
    if (result.steps.some((step) => step.state === 'running')) {
      return { blocksStart: true, kind: 'running', message: 'Setup is running…' };
    }
    return { blocksStart: false, kind: 'ready', message: 'Setup complete.' };
  }
  return {
    blocksStart: true,
    kind: 'error',
    message: 'Setup status is unavailable for this worktree.'
  };
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

export function canPrepareIssueDevelopmentWorkspace(
  state?: IssueDevelopmentEmptyState
) {
  return state?.kind === 'runtime-error' &&
    /development-server worktree is not available/i.test(state.message);
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
  return {
    id: server.serverId,
    label: server.serverLabel || server.serverId,
    path: '/'
  };
}

function surfaceUrl(server: WorktreeDevServerRecord, path: string, now: number) {
  const baseUrl = visibleTailscaleUrl(server, now);
  return baseUrl ? new URL(path, baseUrl).toString() : undefined;
}

export function issueDevelopmentSurfaces(
  servers: WorktreeDevServerRecord[],
  options: { hasRefreshError?: boolean; isDesignSpace?: boolean; now?: number } = {}
) {
  const now = options.now ?? Date.now();
  const surfaces = servers.flatMap<IssueDevelopmentSurface>((server) => {
    const definition = surfaceDefinition(server, options.isDesignSpace ?? false);
    if (!definition) return [];
    const isCurrent = !options.hasRefreshError && isFreshDevServerTimestamp(server.checkedAt, now);
    return [{
      id: definition.id,
      isCurrent,
      label: definition.label,
      server,
      url: isCurrent ? surfaceUrl(server, definition.path, now) : undefined
    }];
  });

  const order = ['app', 'docs', 'prototype', 'native-prototype', 'design-space'];
  const rank = (surface: IssueDevelopmentSurface) => {
    const index = order.indexOf(surface.id);
    return index === -1 ? order.length : index;
  };
  return surfaces.sort((left, right) => rank(left) - rank(right)
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id));
}

export function issueDevelopmentSurfaceRefreshAt(
  servers: WorktreeDevServerRecord[],
  now = Date.now()
) {
  const expirations = servers.flatMap((server) => [server.checkedAt, server.verifiedAt])
    .filter((value): value is string => isFreshDevServerTimestamp(value, now))
    .map((value) => Date.parse(value) + devServerFreshnessMaxAgeMs + 1)
    .filter((value) => value > now);
  return expirations.length > 0 ? Math.min(...expirations) : undefined;
}
