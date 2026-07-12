import { describe, expect, test } from 'bun:test';

import { resolveLocalProjectPath } from '../server/local-project-identity';
import type { ProjectSpaceRecord } from '../src/shared/project-space-api';

const machineId = 'machine-1';
const localProjectId = 'group__project-space';

function scopedProjectId(embeddedMachineId = machineId, embeddedLocalProjectId = localProjectId) {
  return `connector-project:${Buffer.from(embeddedMachineId).toString('base64url')}:${Buffer.from(embeddedLocalProjectId).toString('base64url')}`;
}

function project(id: string, rootPath = `/projects/${id}`): ProjectSpaceRecord {
  return {
    id,
    kind: 'standalone',
    name: id,
    rootPath
  };
}

function discovery(...projects: ProjectSpaceRecord[]) {
  return async () => ({ projects });
}

describe('connector-local project identity', () => {
  test('canonically decodes a machine-scoped project and returns its freshly discovered path', async () => {
    const firstPath = '/projects/old-location';
    const currentPath = '/projects/new-location';

    expect(
      await resolveLocalProjectPath(machineId, scopedProjectId(), {
        discoverProjects: discovery(project(localProjectId, currentPath))
      })
    ).toBe(currentPath);
    expect(currentPath).not.toBe(firstPath);
  });

  test('allows an unscoped local ID only when fresh discovery matches it exactly', async () => {
    expect(
      await resolveLocalProjectPath(machineId, localProjectId, {
        discoverProjects: discovery(project(localProjectId, '/projects/exact'))
      })
    ).toBe('/projects/exact');

    await expect(
      resolveLocalProjectPath(machineId, `${localProjectId}-other`, {
        discoverProjects: discovery(project(localProjectId))
      })
    ).rejects.toThrow('could not be resolved');
  });

  test('preserves canonical Unicode project IDs from local discovery', async () => {
    const unicodeProjectId = 'team__프로젝트';

    expect(
      await resolveLocalProjectPath(machineId, scopedProjectId(machineId, unicodeProjectId), {
        discoverProjects: discovery(project(unicodeProjectId, '/projects/unicode'))
      })
    ).toBe('/projects/unicode');
  });

  test('rejects a scoped project for a different machine before discovery', async () => {
    let discoveryCalled = false;

    await expect(
      resolveLocalProjectPath(machineId, scopedProjectId('machine-2'), {
        discoverProjects: async () => {
          discoveryCalled = true;
          return { projects: [project(localProjectId)] };
        }
      })
    ).rejects.toThrow('does not belong');
    expect(discoveryCalled).toBe(false);
  });

  test('rejects malformed scoped identities instead of treating them as local IDs', async () => {
    const malformed = [
      'connector-project:',
      'connector-project:abc',
      'connector-project:abc:def:ghi',
      'connector-project:abc=:def',
      'connector-project:***:def'
    ];

    for (const projectId of malformed) {
      await expect(
        resolveLocalProjectPath(machineId, projectId, {
          discoverProjects: discovery(project(projectId))
        })
      ).rejects.toThrow('invalid');
    }
  });

  test('rejects noncanonical base64url encodings', async () => {
    const encodedMachine = Buffer.from(machineId).toString('base64url');
    const encodedProject = Buffer.from(localProjectId).toString('base64url');

    await expect(
      resolveLocalProjectPath(machineId, `connector-project:${encodedMachine}A:${encodedProject}`, {
        discoverProjects: discovery(project(localProjectId))
      })
    ).rejects.toThrow('invalid');
  });

  test('rejects invalid UTF-8 in encoded identities', async () => {
    const invalidUtf8 = Buffer.from([0xff]).toString('base64url');

    await expect(
      resolveLocalProjectPath(
        machineId,
        `connector-project:${invalidUtf8}:${Buffer.from(localProjectId).toString('base64url')}`,
        { discoverProjects: discovery(project(localProjectId)) }
      )
    ).rejects.toThrow('invalid');
  });

  test('rejects control characters in signed, scoped, and unscoped identities', async () => {
    const encodedControlProject = Buffer.from('project\nother').toString('base64url');
    const encodedMachine = Buffer.from(machineId).toString('base64url');

    await expect(
      resolveLocalProjectPath('machine\nother', localProjectId, {
        discoverProjects: discovery(project(localProjectId))
      })
    ).rejects.toThrow('invalid');
    await expect(
      resolveLocalProjectPath(
        machineId,
        `connector-project:${encodedMachine}:${encodedControlProject}`,
        {
          discoverProjects: discovery(project('project\nother'))
        }
      )
    ).rejects.toThrow('invalid');
    await expect(
      resolveLocalProjectPath(machineId, 'project\nother', {
        discoverProjects: discovery(project('project\nother'))
      })
    ).rejects.toThrow('invalid');
  });

  test('rejects oversized machine, local, and scoped identities before discovery', async () => {
    const oversizedMachine = 'm'.repeat(257);
    const oversizedProject = 'p'.repeat(1025);

    await expect(
      resolveLocalProjectPath(oversizedMachine, localProjectId, {
        discoverProjects: discovery(project(localProjectId))
      })
    ).rejects.toThrow('invalid');
    await expect(
      resolveLocalProjectPath(machineId, oversizedProject, {
        discoverProjects: discovery(project(oversizedProject))
      })
    ).rejects.toThrow('invalid');
    await expect(
      resolveLocalProjectPath(machineId, scopedProjectId(machineId, oversizedProject), {
        discoverProjects: discovery(project(oversizedProject))
      })
    ).rejects.toThrow('invalid');
  });

  test('rejects missing and duplicate fresh discovery matches', async () => {
    await expect(
      resolveLocalProjectPath(machineId, scopedProjectId(), {
        discoverProjects: discovery(project('different'))
      })
    ).rejects.toThrow('could not be resolved');

    await expect(
      resolveLocalProjectPath(machineId, scopedProjectId(), {
        discoverProjects: discovery(
          project(localProjectId, '/projects/first'),
          project(localProjectId, '/projects/second')
        )
      })
    ).rejects.toThrow('could not be resolved');
  });
});
