import { describe, expect, test } from 'bun:test';

import { createConfiguredTaskDeliveryPolicyResolver } from '../server/task-delivery/completion-policy';

const target = {
  branch: 'issue-562-delivery',
  providerKind: 'github',
  repositoryId: '1001',
  taskId: 'github:DotNaos/project-space:562'
};

function backend(status: 'connected' | 'error' = 'connected') {
  return {
    async getGitHubCatalog() {
      return {
        checkedAt: '2026-08-09T12:00:00.000Z',
        repositories: status === 'connected' ? [{
          fullName: 'DotNaos/project-space', id: 1001, isPrivate: true,
          name: 'project-space', owner: 'DotNaos',
          projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
          url: 'https://github.com/DotNaos/project-space'
        }] : [],
        status
      };
    }
  };
}

describe('configured Task Delivery policy', () => {
  test('requires the configured production deployment independently of observed evidence', async () => {
    const resolve = createConfiguredTaskDeliveryPolicyResolver({ backend: backend() });
    expect(await resolve(target)).toEqual({
      deploymentEnvironment: 'prod', kind: 'deployed_healthy'
    });
  });

  test('uses merge evidence for repositories not configured as deployed services', async () => {
    const resolve = createConfiguredTaskDeliveryPolicyResolver({
      backend: backend(), deployedRepositories: {}
    });
    expect(await resolve(target)).toEqual({ kind: 'merged' });
  });

  test('fails closed when repository authorization cannot be resolved', async () => {
    const resolve = createConfiguredTaskDeliveryPolicyResolver({ backend: backend('error') });
    expect(await resolve(target)).toBeUndefined();
  });
});
