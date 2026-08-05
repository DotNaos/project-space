import { describe, expect, test } from 'bun:test';
import type { ProjectSpaceRecord } from '../src/shared/project-space-api';
import { resolveDefaultProjectId } from '../src/features/project-desktop/hooks/project-desktop-routing';

function project(id: string, name = id): ProjectSpaceRecord {
  return {
    id,
    kind: 'standalone',
    name,
    rootPath: `/projects/${name}`
  };
}

describe('default redesigned project entry', () => {
  const projects = [project('project-a'), project('project-b')];

  test('returns to the last selected project first', () => {
    expect(
      resolveDefaultProjectId({
        pinnedProjectIds: ['project-a'],
        projects,
        recentProjectIds: ['project-a'],
        selectedProjectId: 'project-b'
      })
    ).toBe('project-b');
  });

  test('uses recent, pinned, then the first available project', () => {
    expect(resolveDefaultProjectId({ projects, recentProjectIds: ['project-b'] })).toBe(
      'project-b'
    );
    expect(resolveDefaultProjectId({ pinnedProjectIds: ['project-b'], projects })).toBe(
      'project-b'
    );
    expect(resolveDefaultProjectId({ projects })).toBe('project-a');
  });

  test('preserves a selected GitHub project until the catalog finishes loading', () => {
    expect(
      resolveDefaultProjectId({ projects: [], selectedProjectId: 'github:DotNaos/project-space' })
    ).toBe('github:DotNaos/project-space');
  });

  test('keeps project selection empty when no project exists', () => {
    expect(resolveDefaultProjectId({ projects: [] })).toBe('');
  });

  test('does not open hidden workspace infrastructure as the current project', () => {
    const hiddenProject = project('hidden', '.worktrees');
    hiddenProject.rootPath = '/projects/.worktrees';

    expect(
      resolveDefaultProjectId({
        projects: [hiddenProject, project('project-space')],
        selectedProjectId: hiddenProject.id
      })
    ).toBe('project-space');
    expect(
      resolveDefaultProjectId({ projects: [hiddenProject], selectedProjectId: hiddenProject.id })
    ).toBe('');
  });
});
