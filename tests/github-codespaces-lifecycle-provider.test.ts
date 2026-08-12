import { describe, expect, mock, test } from 'bun:test';

import { createGitHubCodespacesLifecycleProvider } from '../server/execution-environment-lifecycle/github-codespaces-provider';
import type { GitHubCodespaceRunnerRuntime } from '../server/github-codespace-runner/configured-runtime';

const target = {
  branch: 'issue-536-codespace',
  repositoryFullName: 'DotNaos/project-space',
  task: 536
};

describe('GitHub Codespaces lifecycle provider', () => {
  test('keeps native provider state separate and sanitizes provider output', async () => {
    const run = mock(async () => ({
      apiVersion: 1 as const,
      codespace: {
        name: 'reliable-space-536',
        state: 'Available\u0000',
        url: 'javascript:alert(1)'
      },
      message: 'Ready\u0007now',
      operationId: 'operation-provider-ready',
      state: 'ready' as const
    }));
    const provider = createGitHubCodespacesLifecycleProvider({ run }, {
      now: () => new Date('2026-08-09T10:00:00.000Z')
    });

    const result = await provider.provision(target, 'operation-provider-ready');
    expect(result).toMatchObject({
      lifecycleState: 'running',
      message: 'Ready now',
      nativeState: 'Available',
      outcome: 'confirmed',
      providerResourceName: 'reliable-space-536'
    });
    expect(result.providerResourceUrl).toBeUndefined();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ action: 'provision' }));
  });

  test('treats failed mutation responses as uncertain but confirms failed status observations', async () => {
    const runtime: GitHubCodespaceRunnerRuntime = {
      run: mock(async (request) => ({
        apiVersion: 1,
        message: 'Provider request failed.',
        operationId: request.operationId,
        state: 'failed'
      }))
    };
    const provider = createGitHubCodespacesLifecycleProvider(runtime);

    await expect(provider.stop({
      ...target,
      id: 'binding-536',
      lifecycleState: 'running',
      observedAt: '2026-08-09T10:00:00.000Z',
      providerKind: 'github_codespaces',
      providerResourceId: 'reliable-space-536',
      userId: 'user-owner'
    }, 'operation-stop-failed')).resolves.toMatchObject({
      lifecycleState: 'uncertain',
      outcome: 'uncertain'
    });
    await expect(provider.status(target, 'status-failed')).resolves.toMatchObject({
      lifecycleState: 'failed',
      outcome: 'confirmed'
    });
  });

  test('returns a sanitized actionable connector approval URL', async () => {
    const runtime: GitHubCodespaceRunnerRuntime = {
      run: async (request) => ({
        apiVersion: 1,
        approvalUrl: 'https://projects.os-home.net/machines/connect?request=exact#secret',
        message: 'Approval required.',
        operationId: request.operationId,
        state: 'connector-approval-required'
      })
    };
    const provider = createGitHubCodespacesLifecycleProvider(runtime);
    const result = await provider.status(target, 'status-approval');

    expect(result).toMatchObject({
      blockedReason: 'connector_approval_required',
      readiness: {
        approvalUrl: 'https://projects.os-home.net/machines/connect?request=exact',
        state: 'connector_approval_required'
      }
    });
  });
});
