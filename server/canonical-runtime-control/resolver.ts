import {
  canonicalRuntimeControlAccessMode,
  type CanonicalRuntimeControlRequest
} from '../../src/shared/canonical-runtime-control-api';
import {
  workspaceRuntimeControlCapability,
  workspaceRuntimeMutationCapability
} from '../../src/shared/workspace-runtime-session-api';
import type {
  CanonicalRuntimeControlInventory,
  CanonicalRuntimeControlTarget
} from './contracts';
import { CanonicalRuntimeControlError } from './contracts';

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
  const platform = compute.platforms.filter(({ id }) => id === environment.platformId);
  if (platform.length !== 1) unavailable();
  if (environment.hostAssociation.resolution === 'conflict') unavailable();
  const hostId = environment.hostAssociation.resolution === 'verified' ||
    environment.hostAssociation.resolution === 'manual'
    ? environment.hostAssociation.hostId
    : undefined;
  const hosts = hostId ? compute.hosts.filter(({ id }) => id === hostId) : [];
  if (hostId && (hosts.length !== 1 || hosts[0]!.platformId !== environment.platformId)) unavailable();
  const targetIdentityRevision = `${environment.identity.version}:${environment.identity.key}`;
  if (request.expectedTargetIdentityRevision !== targetIdentityRevision) unavailable();
  const matches = runtimes.filter((runtime) =>
    runtime.environmentId === request.environmentId &&
    runtime.workspaceId === request.workspaceId
  );
  if (matches.length !== 1) unavailable();
  const runtime = matches[0]!;
  const capability = canonicalRuntimeControlAccessMode(request.operation) === 'mutation'
    ? workspaceRuntimeMutationCapability
    : workspaceRuntimeControlCapability;
  if (runtime.generation !== request.expectedGeneration ||
      runtime.connectionState !== 'online' || runtime.lifecycleState !== 'running' ||
      !runtime.capabilities.includes(capability)) unavailable();
  return {
    branch: runtime.branch,
    commit: runtime.commit,
    environmentId: request.environmentId,
    generation: runtime.generation,
    ...(hostId ? { hostId } : {}),
    manifestDigest: runtime.manifestDigest,
    platformId: environment.platformId,
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
