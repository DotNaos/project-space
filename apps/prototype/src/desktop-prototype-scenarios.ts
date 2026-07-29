import type { ProjectRootSummaryDataSource } from '../../../src/features/project-desktop/components/project-root-summary-model';
import type { ProjectRootSummaryProps } from '../../../src/features/project-desktop/components/project-root-summary';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  ProjectSpaceRecord
} from '../../../src/shared/project-space-api';
import type { PrototypeScenarioKind } from '../../../src/shared/prototype-canvas';

const checkedAt = '2026-07-27T10:00:00.000Z';

function repository(id: number, name: string): GitHubCatalogRepository {
  return {
    defaultBranch: 'main',
    fullName: `DotNaos/${name}`,
    id,
    isPrivate: true,
    name,
    owner: 'DotNaos',
    projectConfig: {
      projectYaml: true,
      status: 'complete',
      templateLock: true
    },
    url: `https://github.com/DotNaos/${name}`
  };
}

function project(id: number, name: string): ProjectSpaceRecord {
  const github = repository(id, name);
  return {
    github,
    id: `project-${id}`,
    kind: 'standalone',
    machineId: 'os-pc',
    name,
    rootPath: `/workspace/${name}`
  };
}

const readyProjects = [
  project(1, 'project-space'),
  project(2, 'ui'),
  project(3, 'design-space')
];

const longProjects = [
  project(11, 'project-space-with-a-deliberately-long-feature-branch-name'),
  project(12, 'responsive-prototype-surface-with-overflow-proof'),
  project(13, 'design-system-accessibility-and-localization')
];

const readyConnector: ConnectorOverviewResult = {
  machines: [{
    connector: {
      installCommand: 'project connector install',
      lastSeen: checkedAt,
      status: 'online'
    },
    id: 'os-pc',
    kind: 'windows',
    name: 'os-pc',
    network: {},
    roles: ['connector'],
    sourcePath: '/workspace'
  }],
  machinesRepo: { exists: true, path: '/workspace' },
  tailscale: {
    connected: true,
    installed: true,
    ips: [],
    peersOnline: 1,
    serveOrigins: []
  }
};

const offlineConnector: ConnectorOverviewResult = {
  ...readyConnector,
  machines: readyConnector.machines.map((machine) => ({
    ...machine,
    connector: { ...machine.connector, status: 'offline' }
  })),
  tailscale: { ...readyConnector.tailscale, connected: false, peersOnline: 0 }
};

export interface DesktopPrototypeScenario {
  connector: ProjectRootSummaryProps['connector'];
  dataSource: ProjectRootSummaryDataSource;
  projects: ProjectSpaceRecord[];
  recentProjectIds: string[];
}

function dataSource(offline: boolean): ProjectRootSummaryDataSource {
  const fail = () => Promise.reject(new Error('Mock backend offline.'));
  return {
    getRepositorySummary: offline
      ? fail
      : async (fullName) => ({
          branchCount: fullName.includes('design') ? 8 : 16,
          checkedAt,
          fullName,
          openIssueCount: fullName.includes('project-space') ? 57 : 9,
          status: 'connected'
        }),
    listProjectChatChannels: offline
      ? fail
      : async (projectId) => ({
          channels: [{
            channelId: `project:${projectId}`,
            description: 'Project discussion',
            displayName: 'Project',
            kind: 'project',
            projectId
          }]
        }),
    listProjectChatMembers: offline
      ? fail
      : async () => ({
          members: [{
            displayName: 'Juno',
            handle: 'juno',
            memberId: 'agent-juno',
            presence: { lastSeenAt: checkedAt, state: 'working' },
            role: 'agent'
          }]
        })
  };
}

export function desktopPrototypeScenario(kind: PrototypeScenarioKind): DesktopPrototypeScenario {
  const offline = kind === 'offline';
  const projects = kind === 'empty'
    ? []
    : kind === 'long-content'
      ? longProjects
      : readyProjects;
  return {
    connector: offline
      ? { message: 'Mock backend offline.', state: 'blocked' }
      : { checkedAt, state: 'ready', value: readyConnector },
    dataSource: dataSource(offline),
    projects,
    recentProjectIds: projects.map((entry) => entry.id)
  };
}
