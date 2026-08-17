import { describe, expect, test } from 'bun:test';

import { createProjectDesktopTopologyNavigation } from '../src/features/project-desktop/hooks/project-desktop-topology-navigation';
import type { ProjectSpaceRecord } from '../src/shared/project-space-api';

const project: ProjectSpaceRecord = {
  github: {
    defaultBranch: 'main',
    fullName: 'DotNaos/project-space',
    id: 42,
    isPrivate: true,
    name: 'project-space',
    owner: 'DotNaos',
    projectConfig: { status: 'managed' },
    url: 'https://github.com/DotNaos/project-space'
  },
  id: 'github:DotNaos/project-space',
  kind: 'github',
  name: 'project-space',
  rootPath: '/Users/oli/projects/project-space'
};

describe('project task navigation', () => {
  test('opens a task when the route uses a project alias instead of the canonical catalog id', () => {
    const selectedIssues: Array<number | undefined> = [];
    const selectedTabs: string[] = [];
    const selectedViews: string[] = [];
    const originalHistory = globalThis.history;
    Object.defineProperty(globalThis, 'history', {
      configurable: true,
      value: { pushState() {}, replaceState() {} }
    });

    try {
      const navigation = createProjectDesktopTopologyNavigation({
        persistProjectsState: () => undefined,
        pinnedProjectIds: [],
        projectsById: { [project.id]: project },
        projectTab: 'issues',
        pushRecentProject: () => [],
        selectedLauncherAppId: '',
        selectedProjectId: 'project-space',
        setLauncherError: () => undefined,
        setMainView: (view) => selectedViews.push(view),
        setProjectTab: (tab) => selectedTabs.push(tab),
        setSelectedExplorerTarget: () => undefined,
        setSelectedIssueNumber: (issueNumber) => selectedIssues.push(issueNumber),
        setSelectedMachineId: () => undefined,
        setSelectedProjectId: () => undefined
      });

      navigation.openProjectIssue(763);

      expect(selectedIssues).toEqual([763]);
      expect(selectedTabs).toEqual(['issues']);
      expect(selectedViews).toEqual(['project']);
    } finally {
      Object.defineProperty(globalThis, 'history', {
        configurable: true,
        value: originalHistory
      });
    }
  });
});
