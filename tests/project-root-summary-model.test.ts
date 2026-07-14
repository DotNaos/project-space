import { describe, expect, test } from 'bun:test';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';
import {
  acceptProjectRootSummaryResponse,
  loadProjectRootSummaryCounts,
  projectRootMachineCount,
  projectRootSummaryActions,
  projectRootSummaryHref,
  projectRootSummaryScopeKey,
  selectProjectRootSummaryTargets,
  type ProjectRootSummaryDataSource,
  type ProjectRootSummaryLoadResult,
  type ProjectRootSummaryRequestState
} from '../src/features/project-desktop/components/project-root-summary-model';

function repository(
  id: number,
  fullName: string,
  updatedAt = '2026-07-01T00:00:00.000Z'
): GitHubCatalogRepository {
  const [owner, name] = fullName.split('/');
  return {
    fullName,
    id,
    isPrivate: false,
    name: name!,
    owner: owner!,
    projectConfig: {
      projectYaml: true,
      status: 'complete',
      templateLock: true
    },
    updatedAt,
    url: `https://github.com/${fullName}`
  };
}

function localProject(
  id: string,
  name: string,
  github?: GitHubCatalogRepository,
  machineId = 'machine-1'
): ProjectSpaceRecord {
  return {
    github,
    id,
    kind: 'workspace',
    machineId,
    name,
    rootPath: `/projects/${name}`
  };
}

function githubProject(repo: GitHubCatalogRepository): ProjectSpaceRecord {
  return {
    github: repo,
    id: `github:${repo.fullName}`,
    kind: 'github',
    name: repo.fullName,
    rootPath: ''
  };
}

const connector: ConnectorOverviewResult = {
  machines: [
    {
      connector: { lastSeen: '2026-07-13T00:00:00.000Z', status: 'online' },
      id: 'machine-1',
      kind: 'macos',
      name: 'MacBook',
      network: {},
      roles: ['connector'],
      sourcePath: ''
    }
  ],
  machinesRepo: { exists: true, path: '/projects/machines' },
  tailscale: {
    connected: true,
    installed: true,
    ips: [],
    peersOnline: 0,
    serveOrigins: []
  }
};

describe('recent project root summaries', () => {
  test('keeps true recent order and deduplicates local and GitHub records for one repository', () => {
    const alpha = repository(101, 'DotNaos/alpha');
    const beta = repository(102, 'DotNaos/beta');
    const gamma = repository(103, 'DotNaos/gamma');
    const projects = [
      localProject('alpha-local', 'alpha', alpha),
      githubProject(alpha),
      localProject('beta-local', 'beta', beta),
      localProject('gamma-local', 'gamma', gamma)
    ];

    const targets = selectProjectRootSummaryTargets(projects, [
      'github:DotNaos/alpha',
      'beta-local',
      'alpha-local',
      'gamma-local'
    ]);

    expect(targets.map((target) => target.label)).toEqual(['alpha', 'beta', 'gamma']);
    expect(targets[0]?.project.id).toBe('alpha-local');
    expect(targets[0]?.sourceProjectIds).toEqual(['alpha-local', 'github:DotNaos/alpha']);
  });

  test('fills missing history deterministically without pretending repository update time is usage', () => {
    const projects = [
      githubProject(repository(3, 'DotNaos/zulu', '2026-07-13T00:00:00.000Z')),
      githubProject(repository(1, 'DotNaos/alpha', '2025-01-01T00:00:00.000Z')),
      githubProject(repository(2, 'DotNaos/bravo', '2026-07-12T00:00:00.000Z'))
    ];

    expect(selectProjectRootSummaryTargets(projects, []).map((target) => target.label)).toEqual([
      'alpha',
      'bravo',
      'zulu'
    ]);
  });

  test('uses only successful scoped connector evidence for the machine count', () => {
    const target = selectProjectRootSummaryTargets(
      [localProject('alpha-local', 'alpha', repository(101, 'DotNaos/alpha'))],
      ['alpha-local']
    )[0]!;

    expect(
      projectRootMachineCount(target, {
        checkedAt: '2026-07-13T00:00:00.000Z',
        state: 'ready',
        value: connector
      })
    ).toMatchObject({ count: 1, state: 'ready' });
    expect(
      projectRootMachineCount(target, {
        message: 'Connector refresh failed.',
        state: 'blocked'
      })
    ).toEqual({ message: 'Connector refresh failed.', state: 'blocked' });

    const githubOnlyTarget = selectProjectRootSummaryTargets(
      [githubProject(repository(102, 'DotNaos/github-only'))],
      ['github:DotNaos/github-only']
    )[0]!;
    expect(
      projectRootMachineCount(githubOnlyTarget, {
        checkedAt: '2026-07-13T00:00:00.000Z',
        state: 'ready',
        value: connector
      })
    ).toEqual({
      message: 'No project-scoped machine identity is available.',
      state: 'blocked'
    });
  });

  test('builds real deep links, including the shared direct create route only for repositories', () => {
    const target = selectProjectRootSummaryTargets(
      [localProject('alpha local', 'alpha', repository(101, 'DotNaos/alpha'))],
      ['alpha local']
    )[0]!;

    expect(projectRootSummaryActions(target)).toEqual({
      chat: '/projects/alpha%20local/chat',
      issues: '/projects/alpha%20local/issues',
      machines: '/projects/alpha%20local/machines',
      newIssue: '/projects/alpha%20local/issues/new',
      workspaces: '/projects/alpha%20local/workspaces'
    });

    const localOnly = selectProjectRootSummaryTargets(
      [localProject('scratch', 'scratch')],
      ['scratch']
    )[0]!;
    expect(projectRootSummaryActions(localOnly).newIssue).toBeUndefined();
    expect(
      projectRootSummaryHref(
        projectRootSummaryActions(target).issues,
        '?projectSpaceApi=http%3A%2F%2F127.0.0.1%3A8787',
        '#current'
      )
    ).toBe(
      '/projects/alpha%20local/issues?projectSpaceApi=http%3A%2F%2F127.0.0.1%3A8787#current'
    );
  });
});

describe('scoped project summary evidence', () => {
  test('loads open issues, branches, and unique active Project Chat threads for one project', async () => {
    const target = selectProjectRootSummaryTargets(
      [localProject('alpha-local', 'alpha', repository(101, 'DotNaos/alpha'))],
      ['alpha-local']
    )[0]!;
    const dataSource: ProjectRootSummaryDataSource = {
      async getRepositorySummary(fullName) {
        expect(fullName).toBe('DotNaos/alpha');
        return {
          branchCount: 42,
          checkedAt: '2026-07-13T01:00:00.000Z',
          fullName,
          openIssueCount: 147,
          status: 'connected'
        };
      },
      async listProjectChatChannels(projectId) {
        expect(projectId).toBe('github:101');
        return {
          channels: [
            {
              channelId: 'alpha-room',
              description: 'Alpha room',
              displayName: 'alpha',
              kind: 'project',
              navigationProjectId: 'alpha-local',
              projectId: 'github:101'
            }
          ]
        };
      },
      async listProjectChatMembers(channelId) {
        expect(channelId).toBe('alpha-room');
        return {
          members: [
            {
              displayName: 'A',
              handle: 'a',
              memberId: 'a',
              origin: { hostId: 'h', machineId: 'm', threadId: 'thread-1' },
              presence: { lastSeenAt: '2026-07-13T01:00:00.000Z', state: 'working' },
              role: 'agent'
            },
            {
              displayName: 'A duplicate',
              handle: 'a2',
              memberId: 'a2',
              origin: { hostId: 'h', machineId: 'm', threadId: 'thread-1' },
              presence: { lastSeenAt: '2026-07-13T01:01:00.000Z', state: 'idle' },
              role: 'agent'
            },
            {
              displayName: 'Offline',
              handle: 'off',
              memberId: 'off',
              origin: { hostId: 'h', machineId: 'm', threadId: 'thread-2' },
              presence: { lastSeenAt: '2026-07-12T01:00:00.000Z', state: 'offline' },
              role: 'agent'
            }
          ]
        };
      }
    };

    const result = await loadProjectRootSummaryCounts(target, dataSource);
    expect(result.issues).toMatchObject({ count: 147, state: 'ready' });
    expect(result.branches).toMatchObject({ count: 42, state: 'ready' });
    expect(result.threads).toMatchObject({ count: 1, state: 'ready' });
    expect(result.scopeKey).toBe(projectRootSummaryScopeKey(target));
  });

  test('keeps independent failures blocked instead of rendering them as zero', async () => {
    const target = selectProjectRootSummaryTargets(
      [localProject('alpha-local', 'alpha', repository(101, 'DotNaos/alpha'))],
      ['alpha-local']
    )[0]!;
    const result = await loadProjectRootSummaryCounts(target, {
      async getRepositorySummary() {
        throw new Error('GitHub timed out.');
      },
      async listProjectChatChannels() {
        return { channels: [] };
      },
      async listProjectChatMembers() {
        throw new Error('Members should not be requested without a matching room.');
      }
    });

    expect(result.issues).toEqual({ message: 'GitHub timed out.', state: 'blocked' });
    expect(result.branches).toEqual({ message: 'GitHub timed out.', state: 'blocked' });
    expect(result.threads).toEqual({
      message: 'Project Chat returned invalid scoped channel evidence.',
      state: 'blocked'
    });
  });

  test('blocks malformed and wrong-project scoped channel evidence', async () => {
    const target = selectProjectRootSummaryTargets(
      [localProject('alpha-local', 'alpha', repository(101, 'DotNaos/alpha'))],
      ['alpha-local']
    )[0]!;
    const invalidChannelResults = [
      {
        channels: [
          {
            channelId: 'other-room',
            description: 'Other room',
            displayName: 'other',
            kind: 'project',
            projectId: 'github:999'
          }
        ]
      },
      {
        channels: [
          {
            description: 'Alpha room',
            displayName: 'alpha',
            kind: 'project',
            projectId: 'github:101'
          }
        ]
      },
      {
        channels: [
          {
            channelId: 'alpha-room',
            description: 'Alpha room',
            displayName: 'alpha',
            kind: 'project',
            projectId: 'github:101'
          },
          {
            channelId: 'other-room',
            description: 'Other room',
            displayName: 'other',
            kind: 'project',
            projectId: 'github:999'
          }
        ]
      }
    ] as unknown as Array<Awaited<ReturnType<ProjectRootSummaryDataSource['listProjectChatChannels']>>>;

    for (const channels of invalidChannelResults) {
      let memberRequests = 0;
      const result = await loadProjectRootSummaryCounts(target, {
        async getRepositorySummary(fullName) {
          return {
            branchCount: 42,
            checkedAt: '2026-07-13T01:00:00.000Z',
            fullName,
            openIssueCount: 147,
            status: 'connected'
          };
        },
        async listProjectChatChannels(projectId) {
          expect(projectId).toBe('github:101');
          return channels;
        },
        async listProjectChatMembers() {
          memberRequests += 1;
          return { members: [] };
        }
      });

      expect(result.threads).toEqual({
        message: 'Project Chat returned invalid scoped channel evidence.',
        state: 'blocked'
      });
      expect(memberRequests).toBe(0);
    }
  });

  test('rejects late responses from an old generation or different repository scope', () => {
    const current: ProjectRootSummaryRequestState = {
      generation: 2,
      scopeKey: 'github:101:alpha'
    };
    const result: ProjectRootSummaryLoadResult = {
      branches: { checkedAt: '2026-07-13T00:00:00.000Z', count: 2, state: 'ready' },
      issues: { checkedAt: '2026-07-13T00:00:00.000Z', count: 1, state: 'ready' },
      scopeKey: current.scopeKey,
      threads: { checkedAt: '2026-07-13T00:00:00.000Z', count: 1, state: 'ready' }
    };

    expect(
      acceptProjectRootSummaryResponse(current, {
        generation: 1,
        result,
        scopeKey: current.scopeKey
      })
    ).toBe(current);
    expect(
      acceptProjectRootSummaryResponse(current, {
        generation: 2,
        result: { ...result, scopeKey: 'github:999:other' },
        scopeKey: 'github:999:other'
      })
    ).toBe(current);
    expect(
      acceptProjectRootSummaryResponse(current, {
        generation: 2,
        result,
        scopeKey: current.scopeKey
      }).result
    ).toBe(result);
  });
});
