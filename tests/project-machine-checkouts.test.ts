import { describe, expect, test } from 'bun:test';

import { getIssueMachineRows } from '../src/features/project-desktop/components/issue-development-machine-actions';
import {
  branchOptions,
  checkoutForProjectPath,
  parseCloneTargetProbeOutput,
  parseWorktreeOutput
} from '../src/features/project-desktop/components/project-machine-checkout-model';
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
});
