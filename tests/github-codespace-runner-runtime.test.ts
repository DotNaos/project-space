import { describe, expect, mock, test } from 'bun:test';

import {
  createGitHubCodespaceRunnerRuntime,
  githubCodespaceCreateBody,
  GitHubCodespaceInventoryUnavailableError,
  GitHubCodespaceRunnerAuthenticationError,
  listCodespaces,
  type GitHubCodespaceRunnerRuntimeDependencies
} from '../server/github-codespace-runner/configured-runtime';
import { GitHubRequestError } from '../server/local-github-catalog';
import type {
  GitHubCodespaceRunnerRequest,
  GitHubCodespaceRunnerResult
} from '../src/shared/github-codespace-runner-api';

const request: GitHubCodespaceRunnerRequest = {
  action: 'status',
  branch: 'issue-456-codespace',
  issue: 456,
  operationId: 'codespace:00000000-0000-4000-8000-000000000456',
  repositoryFullName: 'DotNaos/project-space'
};

const ready: GitHubCodespaceRunnerResult = {
  apiVersion: 1,
  message: 'ready',
  operationId: request.operationId,
  state: 'ready'
};

function dependencies(overrides: Partial<GitHubCodespaceRunnerRuntimeDependencies> = {}) {
  const run = mock(async () => ready);
  const listCodespaces = mock(async () => [{
    createdAt: '2026-08-16T08:00:00.000Z',
    displayName: 'Project Space #732',
    name: 'project-space-732',
    ref: 'issue-732-redesign-compute-page',
    repositoryFullName: 'DotNaos/project-space',
    state: 'Available',
    url: 'https://github.com/codespaces/project-space-732'
  }]);
  const serialize = mock(async <Result>(
    _request: GitHubCodespaceRunnerRequest,
    operation: () => Promise<Result>
  ) => operation());
  const defaults: GitHubCodespaceRunnerRuntimeDependencies = {
    authRequired: () => true,
    createService: () => ({ run }),
    currentUserId: () => 'user-456',
    listCodespaces,
    now: () => new Date('2026-08-16T09:00:00.000Z'),
    resolveOAuthToken: async () => ({
      scope: 'repo read:user codespace',
      source: 'stored-oauth',
      token: 'test-token'
    }),
    serialize
  };
  return { dependencies: { ...defaults, ...overrides }, listCodespaces, run, serialize };
}

describe('GitHub Codespace runner runtime', () => {
  test('paginates and sanitizes the GitHub-owned Codespace inventory', async () => {
    const calls: Array<[string, string]> = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      created_at: '2026-08-16T08:00:00Z',
      display_name: `Codespace ${index}`,
      git_status: { ref: `branch-${index}` },
      name: `codespace-${index}`,
      repository: { full_name: 'DotNaos/project-space' },
      state: 'Available',
      web_url: `https://github.com/codespaces/codespace-${index}`
    }));
    const request = (async (path: string, token: string) => {
      calls.push([path, token]);
      return {
        codespaces: path.endsWith('page=1') ? firstPage : [{
          created_at: '2026-08-16T08:30:00Z',
          display_name: 'Final\u0000 Codespace',
          git_status: { ref: 'final-branch' },
          name: 'codespace-final',
          repository: { full_name: 'DotNaos/project-space' },
          state: 'Available\u0007',
          web_url: 'javascript:alert(1)'
        }]
      };
    }) as Parameters<typeof listCodespaces>[1];

    const result = await listCodespaces('server-token', request);

    expect(calls).toEqual([
      ['/user/codespaces?per_page=100&page=1', 'server-token'],
      ['/user/codespaces?per_page=100&page=2', 'server-token']
    ]);
    expect(result).toHaveLength(101);
    expect(result.at(-1)).toEqual({
      createdAt: '2026-08-16T08:30:00.000Z',
      displayName: 'Final  Codespace',
      name: 'codespace-final',
      ref: 'final-branch',
      repositoryFullName: 'DotNaos/project-space',
      state: 'Available'
    });
  });

  test('uses GitHub recommended location when creating a Codespace', () => {
    expect(githubCodespaceCreateBody({
      branch: 'issue-456-codespace',
      displayName: 'Project Space #456'
    }, 'EuropeWest')).toEqual({
      devcontainer_path: '.devcontainer/devcontainer.json',
      display_name: 'Project Space #456',
      idle_timeout_minutes: 30,
      location: 'WestEurope',
      ref: 'issue-456-codespace',
      retention_period_minutes: 4_320
    });
  });

  test('falls back to West Europe instead of sending an invalid recommendation', () => {
    expect(githubCodespaceCreateBody({
      branch: 'issue-456-codespace',
      displayName: 'Project Space #456'
    }, 'UnknownRegion')).toHaveProperty('location', 'WestEurope');
  });

  test('falls back to West Europe when GitHub has no recommendation', () => {
    expect(githubCodespaceCreateBody({
      branch: 'issue-456-codespace',
      displayName: 'Project Space #456'
    })).toHaveProperty('location', 'WestEurope');
  });

  test('requires an authenticated server session when authentication is enabled', async () => {
    const fixture = dependencies({ currentUserId: () => undefined });
    const runtime = createGitHubCodespaceRunnerRuntime(fixture.dependencies);

    await expect(runtime.run(request)).rejects.toBeInstanceOf(
      GitHubCodespaceRunnerAuthenticationError
    );
    expect(fixture.run).not.toHaveBeenCalled();
  });

  test('requires the GitHub Codespaces scope before constructing the provider service', async () => {
    const fixture = dependencies({
      resolveOAuthToken: async () => ({
        scope: 'repo read:user',
        source: 'stored-oauth',
        token: 'test-token'
      })
    });
    const runtime = createGitHubCodespaceRunnerRuntime(fixture.dependencies);

    await expect(runtime.run(request)).resolves.toEqual(expect.objectContaining({
      operationId: request.operationId,
      state: 'github-reauthorization-required'
    }));
    expect(fixture.run).not.toHaveBeenCalled();
  });

  test('keeps status read-only and outside the mutation lock', async () => {
    const fixture = dependencies();
    const runtime = createGitHubCodespaceRunnerRuntime(fixture.dependencies);

    await expect(runtime.run(request)).resolves.toEqual(ready);
    expect(fixture.run).toHaveBeenCalledWith(request);
    expect(fixture.serialize).not.toHaveBeenCalled();
  });

  test('lists provider-owned Codespaces through the signed-in OAuth token', async () => {
    const fixture = dependencies();
    const runtime = createGitHubCodespaceRunnerRuntime(fixture.dependencies);

    await expect(runtime.listInventory()).resolves.toEqual({
      apiVersion: 1,
      checkedAt: '2026-08-16T09:00:00.000Z',
      codespaces: [{
        createdAt: '2026-08-16T08:00:00.000Z',
        displayName: 'Project Space #732',
        name: 'project-space-732',
        ref: 'issue-732-redesign-compute-page',
        repositoryFullName: 'DotNaos/project-space',
        state: 'Available',
        url: 'https://github.com/codespaces/project-space-732'
      }],
      provider: { connectionState: 'connected', source: 'github_api' }
    });
    expect(fixture.listCodespaces).toHaveBeenCalledWith('test-token');
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.serialize).not.toHaveBeenCalled();
  });

  test('reports missing and insufficient OAuth connections without calling GitHub', async () => {
    const missing = dependencies({ resolveOAuthToken: async () => null });
    const insufficient = dependencies({
      resolveOAuthToken: async () => ({
        scope: 'repo read:user', source: 'stored-oauth', token: 'test-token'
      })
    });

    await expect(createGitHubCodespaceRunnerRuntime(missing.dependencies).listInventory())
      .resolves.toMatchObject({ provider: { connectionState: 'not_connected' } });
    await expect(createGitHubCodespaceRunnerRuntime(insufficient.dependencies).listInventory())
      .resolves.toMatchObject({ provider: { connectionState: 'scope_insufficient' } });
    expect(missing.listCodespaces).not.toHaveBeenCalled();
    expect(insufficient.listCodespaces).not.toHaveBeenCalled();
  });

  test('maps expired authorization but fails closed on provider outages', async () => {
    const expired = dependencies({
      listCodespaces: async () => {
        throw new GitHubRequestError(401, false);
      }
    });
    const unavailable = dependencies({
      listCodespaces: async () => {
        throw new Error('sensitive upstream detail');
      }
    });

    await expect(createGitHubCodespaceRunnerRuntime(expired.dependencies).listInventory())
      .resolves.toMatchObject({ provider: { connectionState: 'not_connected' } });
    await expect(createGitHubCodespaceRunnerRuntime(unavailable.dependencies).listInventory())
      .rejects.toBeInstanceOf(GitHubCodespaceInventoryUnavailableError);
  });

  test('serializes a mutation before it reaches the provider service', async () => {
    const fixture = dependencies();
    const runtime = createGitHubCodespaceRunnerRuntime(fixture.dependencies);
    const provision = { ...request, action: 'provision' as const };

    await expect(runtime.run(provision)).resolves.toEqual(ready);
    expect(fixture.serialize).toHaveBeenCalledTimes(1);
    expect(fixture.run).toHaveBeenCalledWith(provision);
  });
});
