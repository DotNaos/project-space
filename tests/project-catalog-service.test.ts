import { describe, expect, test } from 'bun:test';

import { buildProjectCliCatalog } from '../server/project-catalog/project-catalog-service';
import type {
  GitHubCatalogRepository,
  GitHubCatalogResult,
  ProjectDiscoveryResult,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';

function repository(id: number, fullName: string): GitHubCatalogRepository {
  const [owner, name] = fullName.split('/') as [string, string];
  return {
    fullName,
    id,
    isPrivate: true,
    name,
    owner,
    projectConfig: {
      projectYaml: true,
      status: 'complete',
      templateLock: true
    },
    url: `https://github.com/${fullName}`
  };
}

function catalog(...repositories: GitHubCatalogRepository[]): GitHubCatalogResult {
  return {
    auth: { login: 'owner', source: 'stored-oauth' },
    cache: { lastUpdated: '2026-07-28T00:00:00.000Z', state: 'fresh' },
    checkedAt: '2026-07-28T00:01:00.000Z',
    repositories,
    status: 'connected'
  };
}

function local(
  machineId: string,
  fullName: string,
  rootPath: string,
  id = rootPath
): ProjectSpaceRecord {
  const [owner, name] = fullName.split('/') as [string, string];
  return {
    github: repository(999, fullName),
    id,
    kind: 'standalone',
    machineId,
    name,
    rootPath
  };
}

function discovery(...projects: ProjectSpaceRecord[]): ProjectDiscoveryResult {
  return {
    groups: [],
    projects,
    rootItems: [],
    rootPath: 'authorized-connectors',
    structureViolations: []
  };
}

describe('project CLI catalog service', () => {
  test('joins account projects only to exact repositories on the caller machine', () => {
    const result = buildProjectCliCatalog(
      catalog(
        repository(2, 'DotNaos/project-space'),
        repository(1, 'DotNaos/design-space')
      ),
      discovery(
        local('caller-mac', 'DotNaos/project-space', '/Users/oli/projects/project-space'),
        local('other-machine', 'DotNaos/design-space', '/home/other/design-space'),
        local('caller-mac', 'someone/private', '/Users/oli/projects/private')
      ),
      'caller-mac'
    );

    expect(result).toEqual({
      account: { login: 'owner' },
      catalog: {
        cacheState: 'fresh',
        checkedAt: '2026-07-28T00:01:00.000Z',
        lastUpdated: '2026-07-28T00:00:00.000Z',
        status: 'connected'
      },
      projects: [
        {
          displayName: 'design-space',
          id: 'github:1',
          localCandidates: [],
          repository: 'DotNaos/design-space'
        },
        {
          displayName: 'project-space',
          id: 'github:2',
          localCandidates: [{
            path: '/Users/oli/projects/project-space',
            projectId: '/Users/oli/projects/project-space'
          }],
          repository: 'DotNaos/project-space'
        }
      ],
      schemaVersion: 1
    });
  });

  test('preserves multiple exact local candidates instead of guessing a checkout', () => {
    const result = buildProjectCliCatalog(
      catalog(repository(2, 'DotNaos/project-space')),
      discovery(
        local('caller-mac', 'DotNaos/project-space', '/projects/z-worktree', 'z'),
        local('caller-mac', 'dotnaos/PROJECT-space', '/projects/main', 'a')
      ),
      'caller-mac'
    );

    expect(result.projects[0]?.localCandidates).toEqual([
      { path: '/projects/main', projectId: 'a' },
      { path: '/projects/z-worktree', projectId: 'z' }
    ]);
  });

  test('keeps stale catalog evidence explicit', () => {
    const stale = catalog(repository(2, 'DotNaos/project-space'));
    stale.cache = {
      lastUpdated: '2026-07-27T00:00:00.000Z',
      state: 'refresh-failed'
    };
    stale.message = 'GitHub refresh failed.';

    expect(buildProjectCliCatalog(stale, discovery(), 'caller-mac').catalog).toEqual({
      cacheState: 'refresh-failed',
      checkedAt: '2026-07-28T00:01:00.000Z',
      lastUpdated: '2026-07-27T00:00:00.000Z',
      message: 'GitHub refresh failed.',
      status: 'connected'
    });
  });
});
