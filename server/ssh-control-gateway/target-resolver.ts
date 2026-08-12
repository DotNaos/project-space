import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';
import type {
  SshGatewayTargetBinding,
  SshGatewayTargetResolver
} from './contracts';
import { SshGatewayError } from './contracts';

export interface OwnerComputeInventorySource {
  load(ownerUserId: string): Promise<ComputeInventorySnapshot>;
}

export class InventorySshGatewayTargetResolver implements SshGatewayTargetResolver {
  constructor(private readonly inventory: OwnerComputeInventorySource) {}

  async resolve(ownerUserId: string, environmentId: string): Promise<SshGatewayTargetBinding> {
    const snapshot = await this.inventory.load(ownerUserId);
    if (snapshot.violations.some((violation) =>
      violation.code === 'duplicate_environment_identity' ||
      violation.code === 'duplicate_environment' || violation.id === environmentId
    )) throw unresolved();
    const environments = snapshot.environments.filter(({ id }) => id === environmentId);
    if (environments.length !== 1) throw unresolved();
    const environment = environments[0]!;
    const platforms = snapshot.platforms.filter(({ id }) => id === environment.platformId);
    const definitions = snapshot.environmentDefinitions.filter(
      ({ id }) => id === environment.environmentDefinitionId
    );
    if (environment.identityResolution === 'conflict' ||
      platforms.length !== 1 || definitions.length !== 1 ||
      definitions[0]!.kind !== environment.kind ||
      environment.hostAssociation.resolution === 'conflict') throw unresolved();
    let hostId: string | undefined;
    const hostAssociation = environment.hostAssociation;
    if ('hostId' in hostAssociation && hostAssociation.hostId) {
      const hosts = snapshot.hosts.filter(({ id }) => id === hostAssociation.hostId);
      if (hosts.length !== 1 || hosts[0]!.platformId !== environment.platformId) throw unresolved();
      hostId = hosts[0]!.id;
    }
    return {
      environmentDefinitionId: definitions[0]!.id,
      environmentId: environment.id,
      ...(hostId ? { hostId } : {}),
      platformId: platforms[0]!.id,
      targetIdentityRevision: `${environment.identity.version}:${environment.identity.key}`
    };
  }
}

function unresolved() {
  return new SshGatewayError('route_unavailable', 'The Environment identity is unresolved.');
}
