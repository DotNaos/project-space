import { describe, expect, test } from 'bun:test';

import { dedupeProjectCatalog } from '../src/features/project-desktop/hooks/project-catalog-model';
import type { ProjectSpaceRecord } from '../src/shared/project-space-api';

function project(
  id: string,
  options: Partial<ProjectSpaceRecord> = {}
): ProjectSpaceRecord {
  return {
    id,
    kind: 'standalone',
    name: id,
    rootPath: `/projects/${id}`,
    ...options
  };
}

describe('project catalog identity', () => {
  test('collapses the local and connector copy of the same checkout', () => {
    const local = project('project-space', {
      machineId: 'os-macbook',
      name: 'project-space',
      rootPath: '/Users/oli/projects/project-space'
    });
    const connector = project('connector-project:machine:project-space', {
      machineId: 'os-macbook',
      name: 'project-space',
      rootPath: '/Users/oli/projects/project-space'
    });

    expect(dedupeProjectCatalog([local, connector])).toEqual([local]);
  });

  test('presents a repository once across machine checkouts', () => {
    const repository = {
      defaultBranch: 'main',
      fullName: 'DotNaos/project-space',
      id: 1,
      isPrivate: true,
      name: 'project-space',
      owner: 'DotNaos',
      projectConfig: {
        projectYaml: true,
        status: 'valid' as const,
        templateLock: true
      },
      url: 'https://github.com/DotNaos/project-space'
    };
    const macbook = project('macbook-project', {
      github: repository,
      machineId: 'os-macbook'
    });
    const pc = project('pc-project', {
      github: repository,
      machineId: 'os-pc',
      rootPath: '/home/oli/projects/project-space'
    });

    expect(dedupeProjectCatalog([macbook, pc])).toEqual([macbook]);
  });

  test('keeps the selected route representative when duplicates exist', () => {
    const local = project('local', {
      machineId: 'os-macbook',
      name: 'project-space',
      rootPath: '/projects/project-space'
    });
    const selected = project('connector', {
      machineId: 'os-macbook',
      name: 'project-space',
      rootPath: '/projects/project-space'
    });

    expect(dedupeProjectCatalog([local, selected], selected.id)).toEqual([selected]);
  });

  test('presents same-named local checkouts as one project context', () => {
    const first = project('first', { name: 'app', rootPath: '/projects/one/app' });
    const second = project('second', { name: 'app', rootPath: '/projects/two/app' });

    expect(dedupeProjectCatalog([first, second])).toEqual([first]);
  });
});
