import { describe, expect, test } from 'bun:test';
import type { GitHubCatalogRepository } from '../src/shared/project-space-api';
import {
  routeProjectIdMatchesRepository,
  routeProjectKeys,
  shouldPreserveUnresolvedProjectRoute
} from '../src/features/project-desktop/hooks/project-route-model';

const repo: GitHubCatalogRepository = {
  defaultBranch: 'main',
  fullName: 'DotNaos/project-space',
  id: 1,
  isPrivate: false,
  name: 'project-space',
  owner: 'DotNaos',
  sshUrl: 'git@github.com:DotNaos/project-space.git',
  url: 'https://github.com/DotNaos/project-space'
};

describe('GitHub project route matching', () => {
  test('matches the short repository name used in project URLs', () => {
    expect(routeProjectIdMatchesRepository('project-space', repo)).toBe(true);
  });

  test('matches full GitHub identifiers and legacy encoded route IDs', () => {
    expect(routeProjectIdMatchesRepository('github:DotNaos/project-space', repo)).toBe(true);
    expect(routeProjectIdMatchesRepository('DotNaos__project-space', repo)).toBe(true);
    expect(routeProjectIdMatchesRepository('os-macbook:DotNaos__project-space', repo)).toBe(true);
  });

  test('does not match unrelated repositories', () => {
    expect(routeProjectIdMatchesRepository('agent-companion', repo)).toBe(false);
  });

  test('derives stable lookup keys from machine-prefixed project ids', () => {
    expect([...routeProjectKeys('os-macbook:DotNaos__project-space')]).toEqual(
      expect.arrayContaining(['dotnaos/project-space', 'project-space'])
    );
  });

  test('preserves short GitHub project routes while the catalog is still loading', () => {
    expect(
      shouldPreserveUnresolvedProjectRoute({
        githubCatalogCheckedAt: '',
        isGitHubRefreshing: false,
        projectId: 'project-space',
        routeProjectResolved: false
      })
    ).toBe(true);
  });

  test('stops preserving unresolved project routes after catalog lookup finishes', () => {
    expect(
      shouldPreserveUnresolvedProjectRoute({
        githubCatalogCheckedAt: '2026-07-09T00:00:00.000Z',
        isGitHubRefreshing: false,
        projectId: 'project-space',
        routeProjectResolved: false
      })
    ).toBe(false);
  });
});
