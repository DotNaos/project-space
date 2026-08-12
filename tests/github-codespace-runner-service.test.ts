import { describe, expect, test } from 'bun:test';

import {
  createGitHubCodespaceRunnerService,
  type GitHubCodespaceRecord,
  type GitHubCodespaceRunnerDependencies
} from '../server/github-codespace-runner/service';
import type { MachineRecord } from '../src/shared/project-space-api';

const request = {
  action: 'status' as const,
  branch: 'issue-456-codespace',
  issue: 456,
  operationId: 'codespace:00000000-0000-4000-8000-000000000456',
  repositoryFullName: 'DotNaos/project-space'
};

const codespace: GitHubCodespaceRecord = {
  createdAt: '2026-08-09T00:00:00.000Z',
  displayName: 'Project Space #456',
  name: 'reliable-space-456',
  repositoryFullName: request.repositoryFullName,
  state: 'Available',
  ref: request.branch,
  url: 'https://github.com/codespaces/reliable-space-456'
};

function connector(capabilities: string[]): MachineRecord {
  return {
    connector: { capabilities, installCommand: 'managed', status: 'online' },
    id: 'connector-codespace',
    kind: 'connector',
    name: codespace.name,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function dependencies(overrides: Partial<GitHubCodespaceRunnerDependencies> = {}) {
  const defaults: GitHubCodespaceRunnerDependencies = {
    create: async () => codespace,
    delete: async () => undefined,
    findApproval: async () => null,
    inventory: async () => ({
      compute: { connectors: [], environments: [], hosts: [], platforms: [], violations: [] },
      connectors: []
    }),
    list: async () => [],
    start: async () => ({ ...codespace, state: 'Starting' }),
    stop: async () => ({ ...codespace, state: 'Shutdown' })
  };
  return { ...defaults, ...overrides };
}

function connectedInventory(capabilities: string[]) {
  return async () => ({
    compute: {
      connectors: [{
        associatedAt: '2026-08-09T00:01:00.000Z',
        connectorId: 'connector-codespace',
        environmentId: 'environment-codespace'
      }],
      environments: [{
        hostAssociation: { evidence: 'provider' as const, resolution: 'not_applicable' as const },
        id: 'environment-codespace',
        identity: { key: 'environment:codespace12345678', version: 1 as const },
        kind: 'github_codespace' as const,
        name: codespace.name,
        platformId: 'platform-codespaces',
        resourceMode: 'dedicated' as const
      }],
      hosts: [],
      platforms: [{ id: 'platform-codespaces', kind: 'github_codespaces' as const, name: 'GitHub Codespaces' }],
      violations: []
    },
    connectors: [connector(capabilities)]
  });
}

describe('GitHub Codespace runner service', () => {
  test('reports an absent task Codespace without creating one during status', async () => {
    const service = createGitHubCodespaceRunnerService(dependencies());
    await expect(service.run(request)).resolves.toEqual(expect.objectContaining({
      state: 'not-created'
    }));
  });

  test('reconciles an uncertain create before it can duplicate a Codespace', async () => {
    let lists = 0;
    const service = createGitHubCodespaceRunnerService(dependencies({
      create: async () => { throw new Error('network outcome unknown'); },
      list: async () => (++lists === 1 ? [] : [codespace])
    }));
    await expect(service.run({ ...request, action: 'provision' })).resolves.toEqual(
      expect.objectContaining({ state: 'provisioning' })
    );
    expect(lists).toBe(2);
  });

  test('fails closed instead of choosing between duplicate task Codespaces', async () => {
    const service = createGitHubCodespaceRunnerService(dependencies({
      list: async () => [codespace, { ...codespace, name: 'duplicate-space-456' }]
    }));
    await expect(service.run(request)).rejects.toThrow('Multiple GitHub Codespaces');
  });

  test('surfaces the exact Project Space approval before connector enrollment', async () => {
    const service = createGitHubCodespaceRunnerService(dependencies({
      findApproval: async () => ({ approvalUrl: 'https://projects.test/machines/connect?request=exact' }),
      list: async () => [codespace]
    }));
    await expect(service.run(request)).resolves.toEqual(expect.objectContaining({
      approvalUrl: 'https://projects.test/machines/connect?request=exact',
      state: 'connector-approval-required'
    }));
  });

  test('distinguishes subscription authorization from a ready runner', async () => {
    const authorization = createGitHubCodespaceRunnerService(dependencies({
      inventory: connectedInventory(['codex.authorization-required.v1', 'codex.runtime.v1']),
      list: async () => [codespace]
    }));
    await expect(authorization.run(request)).resolves.toEqual(expect.objectContaining({
      connectorId: 'connector-codespace',
      environmentId: 'environment-codespace',
      state: 'authorization-required'
    }));

    const ready = createGitHubCodespaceRunnerService(dependencies({
      inventory: connectedInventory(['codex.machine-tasks.v1', 'codex.runtime.v1']),
      list: async () => [codespace]
    }));
    await expect(ready.run(request)).resolves.toEqual(expect.objectContaining({
      state: 'ready'
    }));
  });
});
