import { describe, expect, test } from 'bun:test';
import { createProjectChatProjectProvider } from '../server/project-chat/project-catalog';
import type { ProjectChatContext } from '../server/project-chat/contracts';

const context: ProjectChatContext = {
  actor: {
    accountId: 'account-1',
    displayName: 'Olli',
    handle: 'olli',
    kind: 'human'
  },
  spaceId: 'space-1'
};

function backend() {
  return {
    async getConnectorOverview() {
      return {
        machines: [{ id: 'machine-1', name: 'os-macbook' }, { id: 'machine-2', name: 'private' }]
      } as never;
    },
    async getGitHubCatalog() {
      return {
        checkedAt: '2026-07-12T00:00:00Z',
        repositories: [{
          fullName: 'DotNaos/project-space',
          id: 999,
          isPrivate: true,
          name: 'project-space',
          owner: 'DotNaos',
          projectConfig: {
            projectYaml: true,
            status: 'complete' as const,
            templateLock: true
          },
          url: 'https://github.com/DotNaos/project-space'
        }],
        status: 'connected' as const
      };
    },
    async loadProjectDiscovery() {
      return {
        groups: [],
        projects: [
          {
            github: {
              fullName: 'DotNaos/project-space',
              id: 123,
              isPrivate: false,
              name: 'project-space',
              owner: 'DotNaos',
              projectConfig: {
                projectYaml: false,
                status: 'unknown' as const,
                templateLock: false
              },
              url: 'https://github.com/DotNaos/project-space'
            },
            id: 'project-space',
            kind: 'workspace' as const,
            machineId: 'machine-1',
            name: 'project-space',
            rootPath: '/projects/project-space'
          },
          {
            id: 'private-project',
            kind: 'workspace' as const,
            machineId: 'machine-2',
            name: 'Private project',
            rootPath: '/projects/private-project'
          }
        ],
        rootItems: [],
        rootPath: '/projects',
        structureViolations: []
      };
    }
  };
}

describe('Project Chat visible project catalog', () => {
  test('uses numeric GitHub identity across display/path metadata and avoids duplicate rooms', async () => {
    const listProjects = createProjectChatProjectProvider({
      authRequired: () => false,
      backend: backend()
    });
    const projects = await listProjects(context);
    expect(projects.filter((project) => project.displayName === 'project-space')).toEqual([{
      displayName: 'project-space',
      groupLabel: '@DotNaos',
      navigationProjectId: 'project-space',
      projectId: 'github:999'
    }]);
  });

  test('filters hosted project rooms to machine memberships', async () => {
    const listProjects = createProjectChatProjectProvider({
      authRequired: () => true,
      backend: backend(),
      membershipsFor: async () => [{ machineId: 'machine-1' }]
    });
    expect((await listProjects(context)).map((project) => project.displayName)).toEqual([
      'project-space'
    ]);
  });

  test('does not expose account-wide catalog rooms to an agent outside its machine', async () => {
    const listProjects = createProjectChatProjectProvider({
      authRequired: () => true,
      backend: backend()
    });
    const projects = await listProjects({
      actor: {
        accountId: 'account-1',
        agentName: {
          category: 'mythology',
          displayName: 'Athena'
        },
        kind: 'agent',
        machineId: 'machine-2',
        threadId: '019f5489-7893-7b32-aa5a-6407f6714d39'
      },
      spaceId: 'space-1'
    });

    expect(projects.map((project) => project.displayName)).toEqual(['Private project']);
    expect(projects.some((project) => project.projectId === 'github:999')).toBe(false);
  });
});
