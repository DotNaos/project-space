import { describe, expect, test } from 'bun:test';

import {
  machineSubtitle,
  projectRecordsForCodex
} from '../src/features/project-desktop/components/project-main-model';
import type { MachineRecord, ProjectSpaceRecord } from '../src/shared/project-space-api';

function machine(status: 'offline' | 'online'): MachineRecord {
  return {
    connector: {
      lastSeen: '2026-07-11T00:00:00.000Z',
      status
    },
    id: 'macbook',
    kind: 'connector',
    name: 'MacBook',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

describe('machine subtitle', () => {
  test('marks offline projects as last-known without changing online labels', () => {
    expect(machineSubtitle(machine('offline'))).toContain('Offline');
    expect(machineSubtitle(machine('offline'))).toContain('last-known projects');
    expect(machineSubtitle(machine('online'))).toBe('connector');
  });
});

describe('project Codex record identity', () => {
  test('joins the same local-only project ID across machine-scoped connector records', () => {
    const local: ProjectSpaceRecord = {
      id: 'project-space',
      kind: 'standalone',
      machineId: 'machine-local',
      name: 'Project Space',
      rootPath: '/Users/oli/projects/project-space'
    };
    const remote: ProjectSpaceRecord = {
      ...local,
      id: 'connector-project:bWFjaGluZS1yZW1vdGU:cHJvamVjdC1zcGFjZQ',
      machineId: 'machine-remote',
      rootPath: '/home/oli/projects/project-space'
    };

    expect(projectRecordsForCodex(local, [local, remote]).map((project) => project.machineId))
      .toEqual(['machine-local', 'machine-remote']);
  });

  test('uses repository identity instead of a matching local project name', () => {
    const selected: ProjectSpaceRecord = {
      github: { fullName: 'DotNaos/project-space' } as ProjectSpaceRecord['github'],
      id: 'project-space',
      kind: 'standalone',
      machineId: 'machine-a',
      name: 'Project Space',
      rootPath: '/projects/project-space'
    };
    const unrelated = {
      ...selected,
      github: { fullName: 'Other/project-space' } as ProjectSpaceRecord['github'],
      machineId: 'machine-b'
    };

    expect(projectRecordsForCodex(selected, [selected, unrelated], 'DotNaos/project-space'))
      .toEqual([selected]);
  });

  test('keeps local project identity when its repository was inferred from the catalog', () => {
    const selected: ProjectSpaceRecord = {
      id: 'project-space',
      kind: 'standalone',
      machineId: 'machine-local',
      name: 'Project Space',
      rootPath: '/Users/oli/projects/project-space'
    };
    const remote: ProjectSpaceRecord = {
      ...selected,
      id: 'connector-project:bWFjaGluZS1yZW1vdGU:cHJvamVjdC1zcGFjZQ',
      machineId: 'machine-remote',
      rootPath: '/home/oli/projects/project-space'
    };
    const explicitRepository: ProjectSpaceRecord = {
      ...selected,
      github: { fullName: 'DotNaos/project-space' } as ProjectSpaceRecord['github'],
      id: 'github-project-space',
      machineId: 'machine-github'
    };

    expect(
      projectRecordsForCodex(
        selected,
        [selected, remote, explicitRepository],
        'DotNaos/project-space'
      ).map((project) => project.machineId)
    ).toEqual(['machine-local', 'machine-remote', 'machine-github']);
  });
});
