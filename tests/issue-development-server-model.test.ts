import { describe, expect, test } from 'bun:test';
import {
  canPrepareIssueDevelopmentWorkspace,
  findDesignSpaceProject,
  isConnectorCommandChannelUnavailable,
  issueDevelopmentEmptyState,
  issueDevelopmentSetupState,
  issueDevelopmentSurfaceRefreshAt,
  issueDevelopmentSurfaces
} from '../src/features/project-desktop/components/issue-development-server-model';
import type {
  ProjectSpaceRecord,
  WorktreeDevServerRecord
} from '../src/shared/project-space-api';
import type { WorktreeSetupResult } from '../src/shared/worktree-action-api';

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

function setup(overrides: Partial<WorktreeSetupResult> = {}): WorktreeSetupResult {
  return {
    capability: 'configured',
    checkedAt: '2026-08-05T12:00:00.000Z',
    machineId: 'connector-1',
    projectId: 'project-1',
    steps: [],
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

  test('expires retained server actions and preview URLs without waiting for another refresh', () => {
    const exposure = {
      publicPort: 43121,
      tailscaleIPv4: '100.100.20.5',
      tailscaleUrl: 'http://100.100.20.5:43121/',
      verifiedAt: '2026-08-05T11:59:55.000Z'
    };
    const retained = server('dev', exposure);

    expect(issueDevelopmentSurfaceRefreshAt([retained], now)).toBe(now + 25_001);
    expect(issueDevelopmentSurfaces([retained], {
      now: now + 25_001
    })[0]).toMatchObject({ isCurrent: true, url: undefined });
    expect(issueDevelopmentSurfaces([retained], {
      now,
      hasRefreshError: true
    })[0]).toMatchObject({ isCurrent: false, url: undefined });
    expect(issueDevelopmentSurfaces([retained], {
      now: now + 30_001
    })[0]).toMatchObject({ isCurrent: false, url: undefined });
  });

  test('uses only the Design Space dev server for its surface', () => {
    const surfaces = issueDevelopmentSurfaces([
      server('dev'),
      server('docs')
    ], { isDesignSpace: true, now });

    expect(surfaces.map(({ id }) => id)).toEqual(['design-space']);
  });

  test('keeps custom declared development servers visible', () => {
    const custom = server('storybook', {
      serverId: 'storybook',
      serverLabel: 'Component stories'
    });

    expect(issueDevelopmentSurfaces([custom, server('dev')])).toEqual([
      expect.objectContaining({ id: 'app' }),
      expect.objectContaining({
        id: 'storybook',
        label: 'Component stories',
        server: custom
      })
    ]);
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

  test('turns a disconnected command channel into a safe connector state', () => {
    const rawError = 'cc01e88f-b873-4148-a356-86fec62b224a is registered, but its live command channel is not connected yet. Restart or update the Project Space connector on that machine.';

    expect(isConnectorCommandChannelUnavailable(rawError)).toBe(true);
    expect(issueDevelopmentEmptyState({
      connectorConfigured: true,
      error: rawError,
      hasProject: true,
      isChecking: false,
      isOnline: true,
      surfaceCount: 0
    })).toEqual({
      kind: 'connector-offline',
      message: 'Connector is disconnected.'
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

  test('offers workspace preparation only for the missing worktree state', () => {
    expect(canPrepareIssueDevelopmentWorkspace({
      kind: 'runtime-error',
      message: 'The selected development-server worktree is not available on this machine.'
    })).toBe(true);
    expect(canPrepareIssueDevelopmentWorkspace({
      kind: 'runtime-error',
      message: 'The connector returned an unexpected response.'
    })).toBe(false);
    expect(canPrepareIssueDevelopmentWorkspace({
      kind: 'no-declaration',
      message: 'No development servers are declared for this worktree.'
    })).toBe(false);
  });

  test('gates server start on the exact trusted setup step', () => {
    const required = issueDevelopmentSetupState({
      isChecking: false,
      result: setup({
        steps: [{
          checkedAt: '2026-08-05T12:00:00.000Z',
          commitSha: 'a'.repeat(40),
          declarationDigest: 'digest-1',
          setupStepId: 'install',
          state: 'required'
        }]
      })
    });
    const failed = issueDevelopmentSetupState({
      isChecking: false,
      result: setup({
        steps: [{
          checkedAt: '2026-08-05T12:00:00.000Z',
          commitSha: 'a'.repeat(40),
          declarationDigest: 'digest-1',
          lastError: 'Trusted setup did not complete.',
          setupStepId: 'install',
          state: 'failed'
        }]
      })
    });

    expect(required).toMatchObject({
      action: 'run',
      blocksStart: true,
      kind: 'required',
      setupStepId: 'install'
    });
    expect(failed).toEqual({
      action: 'retry',
      blocksStart: true,
      kind: 'failed',
      message: 'Trusted setup did not complete.',
      setupStepId: 'install'
    });
  });

  test('allows start only after setup is ready or explicitly undeclared', () => {
    expect(issueDevelopmentSetupState({
      isChecking: false,
      result: setup()
    })).toEqual({ blocksStart: false, kind: 'ready', message: 'Setup complete.' });
    expect(issueDevelopmentSetupState({
      isChecking: false,
      result: setup({ capability: 'unavailable' })
    })).toEqual({ blocksStart: false, kind: 'ready', message: 'No setup required.' });
    expect(issueDevelopmentSetupState({
      isChecking: false,
      result: setup({
        capability: 'unavailable',
        lastError: 'Trusted setup is unavailable.'
      })
    })).toEqual({
      blocksStart: true,
      kind: 'error',
      message: 'Trusted setup is unavailable.'
    });
    expect(issueDevelopmentSetupState({
      isChecking: false,
      result: setup({ lastError: 'Trusted setup did not complete.' })
    })).toEqual({
      blocksStart: true,
      kind: 'error',
      message: 'Trusted setup did not complete.'
    });
    expect(issueDevelopmentSetupState({
      isChecking: true,
      result: setup()
    })).toEqual({ blocksStart: true, kind: 'checking', message: 'Checking setup…' });
    expect(issueDevelopmentSetupState({
      isChecking: true
    })).toEqual({ blocksStart: true, kind: 'checking', message: 'Checking setup…' });
  });
});
