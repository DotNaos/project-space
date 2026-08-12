import type { CanonicalRuntimeControlRequest } from '../../src/shared/canonical-runtime-control-api';
import type {
  CanonicalRuntimeControlInventory,
  CanonicalRuntimeControlTarget
} from './contracts';
import { CanonicalRuntimeControlError } from './contracts';

const runtimeControlCapability = 'runtime.control.v1';

export async function resolveCanonicalRuntimeControlTarget(
  inventory: CanonicalRuntimeControlInventory,
  ownerUserId: string,
  request: CanonicalRuntimeControlRequest
): Promise<CanonicalRuntimeControlTarget> {
  const [compute, runtimes] = await Promise.all([
    inventory.compute(ownerUserId),
    inventory.runtimes(ownerUserId)
  ]);
  const environments = compute.environments.filter(({ id }) => id === request.environmentId);
  if (environments.length !== 1 || compute.violations.some((entry) =>
    entry.id === request.environmentId ||
    entry.code === 'duplicate_environment' ||
    entry.code === 'duplicate_environment_identity'
  )) unavailable();
  const environment = environments[0]!;
  const targetIdentityRevision = `${environment.identity.version}:${environment.identity.key}`;
  if (request.expectedTargetIdentityRevision !== targetIdentityRevision) unavailable();
  const matches = runtimes.filter((runtime) =>
    runtime.environmentId === request.environmentId &&
    runtime.workspaceId === request.workspaceId
  );
  if (matches.length !== 1) unavailable();
  const runtime = matches[0]!;
  if (runtime.generation !== request.expectedGeneration ||
      runtime.connectionState !== 'online' || runtime.lifecycleState !== 'running' ||
      !runtime.capabilities.includes(runtimeControlCapability as never)) unavailable();
  return {
    environmentId: request.environmentId,
    generation: runtime.generation,
    sessionId: runtime.sessionId,
    targetIdentityRevision,
    workspaceId: request.workspaceId
  };
}

function unavailable(): never {
  throw new CanonicalRuntimeControlError(
    'target_unavailable',
    'The exact canonical Environment and Workspace Runtime target is unavailable.'
  );
}
