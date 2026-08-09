import { describe, expect, mock, test } from 'bun:test';

import {
  createGitHubCodespaceRunnerRuntime,
  GitHubCodespaceRunnerAuthenticationError,
  type GitHubCodespaceRunnerRuntimeDependencies
} from '../server/github-codespace-runner/configured-runtime';
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
  const serialize = mock(async <Result>(
    _request: GitHubCodespaceRunnerRequest,
    operation: () => Promise<Result>
  ) => operation());
  const defaults: GitHubCodespaceRunnerRuntimeDependencies = {
    authRequired: () => true,
    createService: () => ({ run }),
    currentUserId: () => 'user-456',
    resolveOAuthToken: async () => ({
      scope: 'repo read:user codespace',
      source: 'stored-oauth',
      token: 'test-token'
    }),
    serialize
  };
  return { dependencies: { ...defaults, ...overrides }, run, serialize };
}

describe('GitHub Codespace runner runtime', () => {
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

  test('serializes a mutation before it reaches the provider service', async () => {
    const fixture = dependencies();
    const runtime = createGitHubCodespaceRunnerRuntime(fixture.dependencies);
    const provision = { ...request, action: 'provision' as const };

    await expect(runtime.run(provision)).resolves.toEqual(ready);
    expect(fixture.serialize).toHaveBeenCalledTimes(1);
    expect(fixture.run).toHaveBeenCalledWith(provision);
  });
});
