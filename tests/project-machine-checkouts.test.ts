import { describe, expect, test } from 'bun:test';

import { getIssueMachineRows } from '../src/features/project-desktop/components/issue-development-machine-actions';
import {
  branchOptions,
  checkoutForProjectPath,
  parseCloneTargetProbeOutput,
  parseWorktreeOutput
} from '../src/features/project-desktop/components/project-machine-checkout-model';
import {
  filterMachineBranchOptions,
  orderedMachineBranchOptions,
  previewMachineBranchOptions
} from '../src/features/project-desktop/components/project-machine-branch-model';
import type { WorktreeBranchOption } from '../src/features/project-desktop/components/worktree-branch-list';
import type {
  ConnectorOverviewResult,
  MachineRecord,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';

function machine(id: string): MachineRecord {
  return {
    connector: { status: 'online' },
    id,
    kind: 'connector',
    name: id,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function project(overrides: Partial<ProjectSpaceRecord> = {}): ProjectSpaceRecord {
  return {
    gitStatus: {
      branchName: 'main',
      changed: 0,
      hasUnstagedChanges: false,
      staged: 0,
      unstaged: 0,
      untracked: 0
    },
    id: 'connector-project:b3MtbWFjYm9vaw:cHJvamVjdC1zcGFjZQ',
    kind: 'standalone',
    machineId: 'os-macbook',
    name: 'project-space',
    rootPath: '/Users/oli/projects/project-space',
    ...overrides
  };
}

describe('machine checkout truth', () => {
  test('groups a normalized connector checkout under its registered machine', () => {
    const connectorOverview: ConnectorOverviewResult = {
      machines: [machine('os-macbook')],
      machinesRepo: { exists: false, path: '' },
      physicalMachines: [
        {
          connectorIds: ['os-macbook'],
          id: 'physical-os-macbook',
          kind: 'physical',
          name: 'os-macbook'
        }
      ],
      tailscale: { connected: false, installed: false, ips: [], peersOnline: 0, serveOrigins: [] }
    };
    const rows = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [project()],
      repoFullName: 'DotNaos/project-space'
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.machineId).toBe('os-macbook');
    expect(rows[0]?.project?.rootPath).toBe('/Users/oli/projects/project-space');
  });

  test('shows one physical machine when it has multiple connector installations', () => {
    const localConnector = machine('local-app-server');
    localConnector.connector.status = 'local';
    const remoteConnector = machine('remote-connector');
    const checkout = project({ machineId: remoteConnector.id });
    const connectorOverview: ConnectorOverviewResult = {
      machines: [localConnector, remoteConnector],
      machinesRepo: { exists: false, path: '' },
      physicalMachines: [
        {
          connectorIds: [localConnector.id, remoteConnector.id],
          id: 'physical-os-macbook',
          kind: 'physical',
          name: 'os-macbook'
        }
      ],
      tailscale: { connected: false, installed: false, ips: [], peersOnline: 0, serveOrigins: [] }
    };

    const rows = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [checkout],
      repoFullName: 'DotNaos/project-space'
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectorIds: [localConnector.id, remoteConnector.id],
      machineId: remoteConnector.id,
      physicalMachineId: 'physical-os-macbook',
      physicalMachineName: 'os-macbook',
      project: checkout
    });
  });

  test('discovers main and preserves actual branch truth when the folder name differs', () => {
    expect(checkoutForProjectPath(project(), 'project-space', 'main')).toMatchObject({
      branchName: 'main',
      kind: 'main',
      path: '/Users/oli/projects/project-space'
    });
    expect(
      checkoutForProjectPath(
        project({
          gitStatus: { ...project().gitStatus!, branchName: 'actual-branch' },
          rootPath: '/Users/oli/projects/.worktrees/project-space/folder-alias'
        }),
        'project-space',
        'main'
      )
    ).toMatchObject({
      branchName: 'actual-branch',
      kind: 'worktree',
      path: '/Users/oli/projects/.worktrees/project-space/folder-alias'
    });

    const parsed = parseWorktreeOutput(
      [
        'worktree /Users/oli/projects/project-space\nbranch refs/heads/main',
        'worktree /Users/oli/projects/.worktrees/project-space/folder-alias\nbranch refs/heads/actual-branch'
      ].join('\n\n'),
      '/Users/oli/projects/project-space'
    );
    expect(parsed.map(({ branchName, kind }) => ({ branchName, kind }))).toEqual([
      { branchName: 'actual-branch', kind: 'worktree' },
      { branchName: 'main', kind: 'main' }
    ]);
  });

  test('keeps an existing unregistered target as a real conflict', () => {
    const targets = parseCloneTargetProbeOutput(
      'feature/conflict\t1\t/Users/oli/projects/.worktrees/project-space/feature/conflict'
    );
    const options = branchOptions(
      ['feature/conflict'],
      'main',
      'project-space',
      targets,
      new Map()
    );

    expect(options[0]?.target).toEqual({
      exists: true,
      path: '/Users/oli/projects/.worktrees/project-space/feature/conflict'
    });
    expect(options[0]?.worktree).toBeUndefined();
  });

  test('pins base and previews the three most recently committed registered worktrees', () => {
    const option = (
      branchName: string,
      committedAt?: string,
      local = true
    ): WorktreeBranchOption => ({
      branchName,
      expectedPath: `/worktrees/${branchName}`,
      ...(local ? {
        worktree: {
          branchName,
          headCommittedAt: committedAt,
          id: `wt-${branchName}`,
          isBase: branchName === 'main',
          name: branchName,
          path: `/worktrees/${branchName}`
        }
      } : {})
    });
    const options = [
      option('older', '2026-07-10T00:00:00.000Z'),
      option('remote-only', '2026-07-16T00:00:00.000Z', false),
      option('main', '2026-01-01T00:00:00.000Z'),
      option('newest', '2026-07-15T00:00:00.000Z'),
      {
        ...option('Codex · detached', '2026-07-16T00:00:00.000Z'),
        worktree: {
          ...option('Codex · detached', '2026-07-16T00:00:00.000Z').worktree!,
          branchName: undefined
        }
      },
      option('unknown'),
      option('middle', '2026-07-12T00:00:00.000Z')
    ];

    expect(previewMachineBranchOptions(options, 'main').map((entry) => entry.branchName)).toEqual([
      'main',
      'newest',
      'middle',
      'older'
    ]);
    expect(orderedMachineBranchOptions([...options].reverse(), 'main').map((entry) => entry.branchName)).toEqual([
      'main',
      'Codex · detached',
      'newest',
      'middle',
      'older',
      'unknown',
      'remote-only'
    ]);
  });

  test('searches the complete branch inventory without dropping row metadata', () => {
    const options: WorktreeBranchOption[] = [{
      branchName: 'feature/modal-search',
      expectedPath: '/expected/modal-search',
      target: { exists: true, path: '/target/modal-search' }
    }, {
      branchName: 'other',
      expectedPath: '/expected/other'
    }];

    expect(filterMachineBranchOptions(options, 'target modal')).toEqual([options[0]]);
  });
});
