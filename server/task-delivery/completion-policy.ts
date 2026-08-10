import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { TaskCompletionPolicy, TaskDeliveryProviderTarget } from './contracts';

type TaskDeliveryPolicyBackend = Pick<ProjectSpaceBackend, 'getGitHubCatalog'>;

export type TaskDeliveryCompletionPolicyResolver = (
  target: TaskDeliveryProviderTarget
) => Promise<TaskCompletionPolicy | undefined>;

export interface ConfiguredTaskDeliveryPolicyOptions {
  backend: TaskDeliveryPolicyBackend;
  deployedRepositories?: Readonly<Record<string, string>>;
}

const projectSpaceDeploymentPolicies: Readonly<Record<string, string>> = {
  'dotnaos/project-space': 'prod'
};

export function createConfiguredTaskDeliveryPolicyResolver(
  options: ConfiguredTaskDeliveryPolicyOptions
): TaskDeliveryCompletionPolicyResolver {
  const deployedRepositories = normalizedPolicies(
    options.deployedRepositories ?? projectSpaceDeploymentPolicies
  );
  return async (target) => {
    if (target.providerKind !== 'github') return undefined;
    try {
      const catalog = await options.backend.getGitHubCatalog();
      if (catalog.status !== 'connected') return undefined;
      const repository = catalog.repositories.find((candidate) => (
        String(candidate.id) === target.repositoryId ||
        candidate.fullName.toLowerCase() === target.repositoryId.toLowerCase()
      ));
      if (!repository) return undefined;
      const environment = deployedRepositories.get(repository.fullName.toLowerCase());
      return environment
        ? { deploymentEnvironment: environment, kind: 'deployed_healthy' }
        : { kind: 'merged' };
    } catch {
      return undefined;
    }
  };
}

function normalizedPolicies(input: Readonly<Record<string, string>>) {
  const result = new Map<string, string>();
  for (const [repository, environment] of Object.entries(input)) {
    const normalizedRepository = repository.trim().toLowerCase();
    const normalizedEnvironment = environment.trim();
    if (/^[\w.-]+\/[\w.-]+$/.test(normalizedRepository) &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalizedEnvironment)) {
      result.set(normalizedRepository, normalizedEnvironment);
    }
  }
  return result;
}
