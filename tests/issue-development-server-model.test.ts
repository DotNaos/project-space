import { describe, expect, test } from 'bun:test';
import {
  findDesignSpaceProject,
  issueDevelopmentEmptyState,
  issueDevelopmentSurfaces
} from '../src/features/project-desktop/components/issue-development-server-model';
import type {
  ProjectSpaceRecord,
  WorktreeDevServerRecord
} from '../src/shared/project-space-api';

const now = Date.parse('2026-08-05T12:00:00.000Z');

function server(serverId: string, overrides: Partial<WorktreeDevServerRecord> = {}): WorktreeDevServerRecord {
  return {
    capability: 'configured',
    checkedAt: '2026-08-05T12:00:00.000Z',
    machineId: 'connector-1',
    projectId: 'project-1',
    runTarget: serverId,
    serverId,
    serverLabel: serverId,
    state: 'running',
    worktreeId: 'worktree-1',
    ...overrides
  };
}

describe('issue development server model', () => {
  test('shows task surfaces only through freshly verified Tailscale URLs', () => {
    const exposure = {
      publicPort: 43121,
      tailscaleIPv4: '100.100.20.5',
      tailscaleUrl: 'http://100.100.20.5:43121/',
      verifiedAt: '2026-08-05T11:59:55.000Z'
    };
    const surfaces = issueDevelopmentSurfaces([
      server('dev', exposure),
      server('docs', exposure),
      server('prototype-desktop', exposure),
      server('prototype-mobile', { ...exposure, verifiedAt: '2026-08-05T11:55:00.000Z' })
    ], { now });

    expect(surfaces.map(({ id }) => id)).toEqual([
      'app',
      'docs',
      'prototype',
      'native-prototype'
    ]);
    expect(surfaces[0]?.url).toBe('http://100.100.20.5:43121/');
    expect(surfaces[1]?.url).toBe('http://100.100.20.5:43121/');
    expect(surfaces[2]?.url).toBe('http://100.100.20.5:43121/prototype/desktop/');
    expect(surfaces[3]?.url).toBeUndefined();
  });

  test('uses only the Design Space dev server for its surface', () => {
    const surfaces = issueDevelopmentSurfaces([
      server('dev'),
      server('docs')
    ], { isDesignSpace: true, now });

    expect(surfaces.map(({ id }) => id)).toEqual(['design-space']);
  });

  test('finds the Design Space checkout on the same machine', () => {
    const projects = [{
      id: 'connector-1:design-space',
      kind: 'standalone',
      machineId: 'connector-1',
      name: 'design-space',
      rootPath: '/workspace/design-space'
    }] as ProjectSpaceRecord[];

    expect(findDesignSpaceProject(projects, 'connector-1', 'local')?.id).toBe('connector-1:design-space');
  });

  test('keeps every unavailable machine state explicit', () => {
    expect(issueDevelopmentEmptyState({
      connectorConfigured: false,
      hasProject: false,
      isChecking: false,
      isOnline: false,
      surfaceCount: 0
    })).toEqual({
      kind: 'no-connector',
      message: 'No connector is configured for this machine.'
    });
    expect(issueDevelopmentEmptyState({
      connectorConfigured: true,
      hasProject: true,
      isChecking: false,
      isOnline: false,
      surfaceCount: 0
    })).toEqual({
      kind: 'connector-offline',
      message: 'Connector is offline.'
    });
    expect(issueDevelopmentEmptyState({
      connectorConfigured: true,
      hasProject: false,
      isChecking: false,
      isOnline: true,
      surfaceCount: 0
    })).toEqual({
      kind: 'project-unavailable',
      message: 'Project is not registered in this environment.'
    });
  });

  test('preserves exact inspection errors before falling back to checking or declaration states', () => {
    const exactError = 'The selected development-server worktree is not available on this machine.';

    expect(issueDevelopmentEmptyState({
      connectorConfigured: true,
      error: exactError,
      hasProject: true,
      isChecking: true,
      isOnline: true,
      surfaceCount: 0
    })).toEqual({ kind: 'runtime-error', message: exactError });
    expect(issueDevelopmentEmptyState({
      connectorConfigured: true,
      hasProject: true,
      isChecking: true,
      isOnline: true,
      surfaceCount: 0
    })).toEqual({ kind: 'checking', message: 'Checking servers…' });
    expect(issueDevelopmentEmptyState({
      connectorConfigured: true,
      hasProject: true,
      isChecking: false,
      isOnline: true,
      surfaceCount: 0
    })).toEqual({
      kind: 'no-declaration',
      message: 'No development servers are declared for this worktree.'
    });
  });

  test('does not render an empty-state message when a server surface exists', () => {
    expect(issueDevelopmentEmptyState({
      connectorConfigured: true,
      error: 'A partial inspection failed.',
      hasProject: true,
      isChecking: true,
      isOnline: true,
      surfaceCount: 1
    })).toBeUndefined();
  });
});
