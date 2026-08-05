import { describe, expect, test } from 'bun:test';
import type { ProjectSpaceRecord } from '../src/shared/project-space-api';
import {
  projectDesktopPageTitle,
  projectSpaceDefaultPageTitle
} from '../src/features/project-desktop/components/project-desktop-page-title';

function project(overrides: Partial<ProjectSpaceRecord> = {}): ProjectSpaceRecord {
  return {
    id: 'workspace:project-space',
    kind: 'workspace',
    name: 'project-space',
    rootPath: '/projects/project-space',
    ...overrides
  };
}

describe('project desktop browser title', () => {
  test('identifies the Tasks page and selected project', () => {
    expect(projectDesktopPageTitle({
      mainView: 'project',
      project: project(),
      projectTab: 'codex'
    })).toBe('Tasks · project-space · Project Space');
  });

  test('updates the title when the selected project changes', () => {
    expect(projectDesktopPageTitle({
      mainView: 'project',
      project: project({
        github: {
          defaultBranch: 'main',
          fullName: 'DotNaos/design-space',
          id: 2,
          name: 'design-space',
          owner: 'DotNaos',
          private: true,
          url: 'https://github.com/DotNaos/design-space'
        }
      }),
      projectTab: 'codex'
    })).toBe('Tasks · design-space · Project Space');
  });

  test('restores the default title after navigating away from Tasks', () => {
    expect(projectDesktopPageTitle({
      mainView: 'project',
      project: project(),
      projectTab: 'overview'
    })).toBe(projectSpaceDefaultPageTitle);
    expect(projectDesktopPageTitle({
      mainView: 'projects',
      project: project(),
      projectTab: 'codex'
    })).toBe(projectSpaceDefaultPageTitle);
  });
});
