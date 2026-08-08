import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createPreviewHubService, previewHubInventoryRevision } from '../server/preview-hub-service';

const repository = 'DotNaos/project-space';
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);

function details() {
  return {
    branches: [],
    checkedAt: '2026-07-31T00:00:00.000Z',
    issues: [],
    pullRequests: [1, 2, 3, 4].map((number) => ({
      headSha: number === 4 ? otherSha : sha,
      number,
      state: 'open' as const,
      title: `PR ${number}`,
      url: `https://github.com/${repository}/pull/${number}`
    })),
    status: 'connected' as const
  };
}

async function testResolveGitHubToken() {
  return { login: 'test-user', source: 'stored-oauth' as const, token: 'test-github-token' };
}

function status(number: number, lifecycle: 'ready' | 'online', requestedSha = sha) {
  return {
    currentHeadSha: requestedSha,
    liveUrl: lifecycle === 'online' ? `https://pr-${number}.projects.os-home.net` : undefined,
    liveUrlState: lifecycle === 'online' ? 'available' as const : 'not-configured' as const,
    pullRequestNumber: number,
    prototypeHealthy: lifecycle === 'online',
    prototypeMetaSha: lifecycle === 'online' ? requestedSha : undefined,
    prototypeUrl: lifecycle === 'online' ? `https://pr-${number}.projects.os-home.net/prototype/desktop/` : undefined,
    prototypeUrlState: lifecycle === 'online' ? 'available' as const : 'not-configured' as const,
    repositoryFullName: repository,
    requestedSha,
    runningSha: lifecycle === 'online' ? requestedSha : undefined,
    state: lifecycle,
    updatedAt: '2026-07-31T00:00:00.000Z',
    verifiedAt: lifecycle === 'online' ? '2026-07-31T00:00:00.000Z' : undefined
  };
}

describe('Preview hub service', () => {
  test('uses the exact newline-free canonical inventory revision shared with the runner', () => {
    const records = [1, 2].map((number) => ({
      lifecycle: 'ready' as const,
      pullRequestNumber: number,
      requestedHeadSha: sha,
      repositoryFullName: repository,
      stateChangedAt: '2026-07-31T00:00:00.000Z',
      verifiedRunningHeadSha: undefined,
      allowedActions: ['start']
    }));
    const canonical = JSON.stringify(records.map((record) => ({
      repositoryFullName: record.repositoryFullName,
      pullRequestNumber: record.pullRequestNumber,
      requestedSha: record.requestedHeadSha,
      runningSha: null,
      state: record.lifecycle,
      capacityBlocked: false,
      updatedAt: record.stateChangedAt
    })));
    expect(previewHubInventoryRevision(records)).toBe(
      createHash('sha256').update(canonical).digest('hex')
    );
  });

  test('uses the raw registry identity when the correlated GitHub head has moved', () => {
    const records = [{
      lifecycle: 'failed' as const,
      pullRequestNumber: 1,
      requestedHeadSha: otherSha,
      repositoryFullName: repository,
      stateChangedAt: '2026-07-31T00:00:00.000Z',
      verifiedRunningHeadSha: undefined,
      allowedActions: []
    }];
    const raw = [{
      currentHeadSha: otherSha,
      pullRequestNumber: 1,
      repositoryFullName: repository,
      requestedSha: sha,
      runningSha: sha,
      state: 'online' as const,
      updatedAt: '2026-07-31T00:00:00.000Z',
      liveUrlState: 'not-configured' as const
    }];
    const canonical = JSON.stringify([{
      repositoryFullName: repository,
      pullRequestNumber: 1,
      requestedSha: sha,
      runningSha: sha,
      state: 'online',
      capacityBlocked: false,
      updatedAt: '2026-07-31T00:00:00.000Z'
    }]);
    expect(previewHubInventoryRevision(records, raw)).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  test('canonicalizes offline and retained-runtime failures without a running SHA', () => {
    const records = [
      {
        lifecycle: 'ready' as const,
        pullRequestNumber: 1,
        requestedHeadSha: sha,
        repositoryFullName: repository,
        stateChangedAt: '2026-07-31T00:00:00.000Z',
        verifiedRunningHeadSha: undefined,
        allowedActions: ['start']
      },
      {
        capacityBlocked: true,
        lifecycle: 'failed' as const,
        pullRequestNumber: 2,
        requestedHeadSha: sha,
        repositoryFullName: repository,
        stateChangedAt: '2026-07-31T00:00:00.000Z',
        verifiedRunningHeadSha: undefined,
        allowedActions: []
      }
    ];
    const canonical = JSON.stringify(records.map((record) => ({
      repositoryFullName: record.repositoryFullName,
      pullRequestNumber: record.pullRequestNumber,
      requestedSha: record.requestedHeadSha,
      runningSha: null,
      state: record.lifecycle,
      capacityBlocked: record.capacityBlocked ?? false,
      updatedAt: record.stateChangedAt
    })));
    expect(previewHubInventoryRevision(records)).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  test('returns a typed capacity choice and binds replacement details to the trusted dispatch', async () => {
    const calls: string[][] = [];
    const service = createPreviewHubService({ getGitHubRepositoryDetails: async () => details() }, {
      loadStatus: async () => ({ checkedAt: '2026-07-31T00:00:00.000Z', previews: [1, 2, 3].map((number) => status(number, 'online')).concat(status(4, 'ready', otherSha)), repositoryFullName: repository, status: 'available' }),
      maxOnline: 3,
      resolveGitHubToken: testResolveGitHubToken,
      run: async (args) => { calls.push(args); return { exitCode: 0, stderr: '', stdout: '{}' }; }
    });

    const inventory = await service.inventory();
    expect(inventory.onlineCount).toBe(3);
    const choice = await service.start({ pullRequestNumber: 4, repositoryFullName: repository, requestedHeadSha: otherSha });
    expect(choice.code).toBe('capacity_requires_choice');
    if (choice.code !== 'capacity_requires_choice') return;

    const accepted = await service.start({
      inventoryRevision: choice.inventoryRevision,
      pullRequestNumber: 4,
      repositoryFullName: repository,
      requestedHeadSha: otherSha,
      selectedReplacementHeadSha: sha,
      selectedReplacementPullRequestNumber: 1,
      selectedReplacementRepositoryFullName: repository
    });
    expect(accepted.code).toBe('accepted');
    expect(calls[0]).toEqual([
      'deploy', 'preview', 'start', '--pr', '4', '--format', 'json',
      '--inventory-revision', choice.inventoryRevision,
      '--replace-pr', '1', '--replace-repository', repository, '--replace-head-sha', sha
    ]);
  });

  test('deploys a brand-new PR that has never been previewed via the build operation, not "start"', async () => {
    const calls: string[][] = [];
    const service = createPreviewHubService({ getGitHubRepositoryDetails: async () => details() }, {
      loadStatus: async () => ({ checkedAt: '2026-07-31T00:00:00.000Z', previews: [status(1, 'ready')], repositoryFullName: repository, status: 'available' }),
      maxOnline: 3,
      resolveGitHubToken: testResolveGitHubToken,
      run: async (args) => { calls.push(args); return { exitCode: 0, stderr: '', stdout: '{}' }; }
    });

    const inventory = await service.inventory();
    const undeployed = inventory.previews.find((preview) => preview.pullRequestNumber === 2);
    expect(undeployed).toMatchObject({ lifecycle: 'not_deployed', requestedHeadSha: sha });
    expect(undeployed?.allowedActions).toEqual(['deploy']);

    const accepted = await service.start({ pullRequestNumber: 2, repositoryFullName: repository, requestedHeadSha: sha });
    expect(accepted).toMatchObject({ code: 'accepted', lifecycle: 'building' });
    expect(calls[0]).toEqual(['deploy', 'preview', '--pr', '2', '--format', 'json']);
  });

  test('fails fast (no replacement flow) deploying a new PR when Preview capacity is full', async () => {
    const service = createPreviewHubService({ getGitHubRepositoryDetails: async () => details() }, {
      loadStatus: async () => ({
        checkedAt: '2026-07-31T00:00:00.000Z',
        previews: [1, 2, 3].map((number) => status(number, 'online')),
        repositoryFullName: repository,
        status: 'available'
      }),
      maxOnline: 3,
      resolveGitHubToken: testResolveGitHubToken,
      run: async () => ({ exitCode: 0, stderr: '', stdout: '{}' })
    });

    const result = await service.start({ pullRequestNumber: 4, repositoryFullName: repository, requestedHeadSha: otherSha });
    expect(result).toMatchObject({
      code: 'operation_failed',
      message: 'All Preview capacity is currently in use. Stop a running preview before deploying a new one.'
    });
  });

  test('redacts credential-like CLI failures and rejects unsafe return targets', async () => {
    const service = createPreviewHubService({ getGitHubRepositoryDetails: async () => details() }, {
      loadStatus: async () => ({ checkedAt: '2026-07-31T00:00:00.000Z', previews: [status(4, 'ready', otherSha)], repositoryFullName: repository, status: 'available' }),
      resolveGitHubToken: testResolveGitHubToken,
      run: async () => ({ exitCode: 1, stderr: 'op://vault/item/password Bearer abc secret=value', stdout: '' })
    });
    const result = await service.start({ pullRequestNumber: 4, repositoryFullName: repository, requestedHeadSha: otherSha, returnTarget: 'https://evil.example/' });
    expect(result).toMatchObject({ code: 'invalid_return_target' });
    const failure = await service.start({ pullRequestNumber: 4, repositoryFullName: repository, requestedHeadSha: otherSha });
    expect(failure).toMatchObject({ code: 'operation_failed', message: '[redacted-secret-reference] [redacted-credential] [redacted-secret]' });
  });

  test('strips the CLI\'s "VIOLATION" stderr prefix before showing the failure message', async () => {
    const service = createPreviewHubService({ getGitHubRepositoryDetails: async () => details() }, {
      loadStatus: async () => ({ checkedAt: '2026-07-31T00:00:00.000Z', previews: [status(4, 'ready', otherSha)], repositoryFullName: repository, status: 'available' }),
      resolveGitHubToken: testResolveGitHubToken,
      run: async () => ({
        exitCode: 1,
        stderr: "VIOLATION resolve GitHub origin: fatal: detected dubious ownership in repository at '/workspace/backend-repo'",
        stdout: ''
      })
    });
    const failure = await service.start({ pullRequestNumber: 4, repositoryFullName: repository, requestedHeadSha: otherSha });
    expect(failure).toMatchObject({
      code: 'operation_failed',
      message: "resolve GitHub origin: fatal: detected dubious ownership in repository at '/workspace/backend-repo'"
    });
  });

  test('forwards the caller\'s connected GitHub OAuth token to the CLI as GITHUB_TOKEN', async () => {
    const environments: (NodeJS.ProcessEnv | undefined)[] = [];
    const service = createPreviewHubService({ getGitHubRepositoryDetails: async () => details() }, {
      loadStatus: async () => ({ checkedAt: '2026-07-31T00:00:00.000Z', previews: [status(4, 'ready', otherSha)], repositoryFullName: repository, status: 'available' }),
      resolveGitHubToken: testResolveGitHubToken,
      run: async (_args, _cwd, options) => { environments.push(options?.environment); return { exitCode: 0, stderr: '', stdout: '{}' }; }
    });
    const result = await service.start({ pullRequestNumber: 4, repositoryFullName: repository, requestedHeadSha: otherSha });
    expect(result.code).toBe('accepted');
    expect(environments).toEqual([{ GITHUB_TOKEN: 'test-github-token' }]);
  });

  test('does not dispatch the CLI and reports unauthorized when no GitHub token is connected', async () => {
    const ran = { called: false };
    const service = createPreviewHubService({ getGitHubRepositoryDetails: async () => details() }, {
      loadStatus: async () => ({ checkedAt: '2026-07-31T00:00:00.000Z', previews: [status(4, 'ready', otherSha)], repositoryFullName: repository, status: 'available' }),
      resolveGitHubToken: async () => null,
      run: async () => { ran.called = true; return { exitCode: 0, stderr: '', stdout: '{}' }; }
    });
    const result = await service.start({ pullRequestNumber: 4, repositoryFullName: repository, requestedHeadSha: otherSha });
    expect(result).toMatchObject({ code: 'unauthorized' });
    expect(ran.called).toBe(false);
  });
});
