import { expect, test } from 'bun:test';
import type {
  AppMeta,
  ProjectDiscoveryResult,
  ProjectsState
} from '../src/shared/project-space-api';
import {
  loadProjectDesktopBootstrap,
  type ProjectDesktopBootstrapClient
} from '../src/features/project-desktop/hooks/project-desktop-bootstrap';

const appMeta: AppMeta = {
  name: 'project-space',
  platform: 'test',
  runtime: 'test',
  version: 'test'
};

const discovery: ProjectDiscoveryResult = {
  groups: [],
  projects: [],
  rootItems: [],
  rootPath: '',
  structureViolations: []
};

const projectsState: ProjectsState = {
  activeGroupId: '',
  pinnedProjectIds: [],
  recentProjectIds: [],
  selectedExplorerTarget: { kind: 'workspace' },
  selectedLauncherAppId: '',
  selectedProjectId: ''
};

test('primary Project desktop bootstrap never requests the retired Connector overview', async () => {
  const calls: string[] = [];
  const client = {
    getAppMeta: async () => {
      calls.push('getAppMeta');
      return appMeta;
    },
    getConnectorOverview: async () => {
      calls.push('getConnectorOverview');
      throw new Error('retired Connector overview must not be requested');
    },
    loadProjectDiscovery: async () => {
      calls.push('loadProjectDiscovery');
      return discovery;
    },
    loadProjectsState: async () => {
      calls.push('loadProjectsState');
      return projectsState;
    }
  } as ProjectDesktopBootstrapClient & { getConnectorOverview(): Promise<never> };

  await expect(loadProjectDesktopBootstrap(client)).resolves.toEqual([
    projectsState,
    discovery,
    appMeta
  ]);
  expect(calls).toContain('loadProjectsState');
  expect(calls).toContain('loadProjectDiscovery');
  expect(calls).toContain('getAppMeta');
  expect(calls).not.toContain('getConnectorOverview');
});
