import { afterEach, describe, expect, test } from 'bun:test';

import { createProjectDesktopTopologyNavigation } from '../src/features/project-desktop/hooks/project-desktop-topology-navigation';

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
    return;
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow
  });
});

describe('project issue creation navigation', () => {
  test('opens the existing creation route from an issue detail', () => {
    const pushedUrls: string[] = [];
    const selectedIssueNumbers: Array<number | undefined> = [];
    const selectedTabs: string[] = [];
    const selectedViews: string[] = [];
    const projectId = 'github:DotNaos/project-space';

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        history: {
          pushState(_state: unknown, _unused: string, url: string) {
            pushedUrls.push(url);
          }
        },
        location: {
          hash: '',
          pathname: '/projects/github%3ADotNaos%2Fproject-space/issues/231',
          search: ''
        }
      }
    });

    const navigation = createProjectDesktopTopologyNavigation({
      persistProjectsState: () => undefined,
      pinnedProjectIds: [],
      projectTab: 'issues',
      projectsById: {
        [projectId]: {
          id: projectId,
          kind: 'github',
          name: 'DotNaos/project-space',
          rootPath: ''
        }
      },
      pushRecentProject: () => [],
      selectedLauncherAppId: '',
      selectedProjectId: projectId,
      setLauncherError: () => undefined,
      setMainView: (view) => selectedViews.push(view),
      setProjectTab: (tab) => selectedTabs.push(tab),
      setSelectedExplorerTarget: () => undefined,
      setSelectedIssueNumber: (issueNumber) => selectedIssueNumbers.push(issueNumber),
      setSelectedMachineId: () => undefined,
      setSelectedProjectId: () => undefined
    });

    navigation.openProjectIssueCreation();

    expect(selectedTabs).toEqual(['issues']);
    expect(selectedIssueNumbers).toEqual([undefined]);
    expect(selectedViews).toEqual(['project']);
    expect(pushedUrls).toEqual([
      '/projects/github%3ADotNaos%2Fproject-space/issues/new'
    ]);
  });
});
