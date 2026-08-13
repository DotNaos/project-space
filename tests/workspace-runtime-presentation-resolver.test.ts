import { describe, expect, test } from 'bun:test';

import { getCurrentAuthSession } from '../server/local-auth-store';
import { createWorkspaceRuntimePresentationResolver } from '../server/workspace-runtime-session/presentation-resolver';

const commit = 'a'.repeat(40);
const execution = {
  agent: { kind: 'codex' as const },
  createdAt: '2026-08-13T00:00:00.000Z',
  environmentId: '11111111-1111-4111-8111-111111111111',
  handoff: { id: '55555555-5555-4555-8555-555555555555', revision: 1 },
  id: '66666666-6666-4666-8666-666666666666',
  ownerUserId: 'owner-one',
  source: {
    branch: 'issue-717', commit, repositoryId: '42',
    taskId: 'github:DotNaos/project-space:717'
  },
  state: 'running' as const,
  updatedAt: '2026-08-13T00:00:00.000Z',
  version: 3
};
const workspace = {
  branch: execution.source.branch,
  commit,
  createdAt: execution.createdAt,
  executionId: execution.id,
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'worktree' as const,
  repositoryId: execution.source.repositoryId,
  state: 'ready' as const,
  updatedAt: execution.updatedAt,
  version: 1
};
const repository = {
  fullName: 'DotNaos/project-space', id: 42, isPrivate: true, name: 'project-space',
  owner: 'DotNaos', projectConfig: { projectYaml: true, status: 'complete', templateLock: true },
  url: 'https://github.com/DotNaos/project-space'
};

function backend(observedOwners: string[] = []) {
  return {
    async getGitHubCatalog() {
      observedOwners.push(getCurrentAuthSession()?.userId ?? '');
      return {
        auth: { login: 'owner', source: 'stored-oauth' }, checkedAt: new Date().toISOString(),
        repositories: [repository], status: 'connected'
      } as const;
    }
  };
}

function store(overrides: {
  execution?: typeof execution;
  workspace?: typeof workspace;
} = {}) {
  return {
    async readByExecutor(ownerUserId: string, agent: string, externalId: string) {
      if (ownerUserId !== 'owner-one' || agent !== 'codex' ||
        externalId !== '44444444-4444-4444-8444-444444444444') return undefined;
      return overrides.execution ?? execution;
    },
    async readWorkspace(ownerUserId: string, executionId: string) {
      if (ownerUserId !== 'owner-one' || executionId !== execution.id) return undefined;
      return overrides.workspace ?? workspace;
    }
  };
}

function input() {
  return {
    branch: execution.source.branch,
    commit,
    environmentId: execution.environmentId,
    ownerUserId: execution.ownerUserId,
    workspaceId: workspace.id,
    worktreeOwnerThreadId: '44444444-4444-4444-8444-444444444444'
  };
}

describe('Workspace Runtime safe presentation resolver', () => {
  test('resolves the repository and task only from the authoritative execution and worktree binding', async () => {
    const observedOwners: string[] = [];
    const resolve = createWorkspaceRuntimePresentationResolver(
      backend(observedOwners) as never,
      store() as never
    );
    await expect(resolve(input())).resolves.toEqual({
      repository: 'DotNaos/project-space', task: { number: 717 }
    });
    expect(observedOwners).toEqual(['owner-one']);
  });

  test('rejects caller context that is not bound to the exact owner, Environment, Workspace, and commit', async () => {
    const resolve = createWorkspaceRuntimePresentationResolver(backend() as never, store() as never);
    await expect(resolve({
      ...input(), worktreeOwnerThreadId: '77777777-7777-4777-8777-777777777777'
    })).resolves.toBeUndefined();
    await expect(resolve({ ...input(), workspaceId: '88888888-8888-4888-8888-888888888888' }))
      .resolves.toBeUndefined();
    await expect(resolve({ ...input(), commit: 'b'.repeat(40) })).resolves.toBeUndefined();
  });

  test('requires the execution repository to remain owner-visible by its stable provider ID', async () => {
    const changed = {
      ...execution,
      source: { ...execution.source, repositoryId: '999' }
    };
    const resolve = createWorkspaceRuntimePresentationResolver(
      backend() as never,
      store({ execution: changed, workspace: { ...workspace, repositoryId: '999' } }) as never
    );
    await expect(resolve(input())).resolves.toBeUndefined();
  });

  test('keeps the Repository but omits a task that is not bound to the same Project record', async () => {
    const changed = {
      ...execution,
      source: { ...execution.source, taskId: 'github:DotNaos/another-project:717' }
    };
    const resolve = createWorkspaceRuntimePresentationResolver(
      backend() as never,
      store({ execution: changed }) as never
    );
    await expect(resolve(input())).resolves.toEqual({ repository: repository.fullName });
  });

  test('keeps catalog and execution-store failures out of the Runtime launch path', async () => {
    const catalogFailure = createWorkspaceRuntimePresentationResolver({
      async getGitHubCatalog() { throw new Error('catalog unavailable'); }
    } as never, store() as never);
    await expect(catalogFailure(input())).resolves.toBeUndefined();

    const storeFailure = createWorkspaceRuntimePresentationResolver(backend() as never, {
      async readByExecutor() { throw new Error('store unavailable'); },
      async readWorkspace() { throw new Error('store unavailable'); }
    } as never);
    await expect(storeFailure(input())).resolves.toBeUndefined();
  });
});
