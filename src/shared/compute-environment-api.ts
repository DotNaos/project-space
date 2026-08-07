export type ComputePlatformKind =
  | 'local'
  | 'github_codespaces'
  | 'cloud_sandbox'
  | 'kubernetes'
  | 'virtualization'
  | 'other';

export type ComputeEnvironmentKind =
  | 'native_macos'
  | 'native_windows'
  | 'native_linux'
  | 'wsl'
  | 'docker'
  | 'devbox'
  | 'github_codespace'
  | 'cloud_sandbox'
  | 'kubernetes_workload'
  | 'virtual_machine'
  | 'other';

export type HostResolution =
  | 'verified'
  | 'manual'
  | 'unresolved'
  | 'conflict'
  | 'not_applicable';

export type HostEvidence =
  | 'provider'
  | 'tpm'
  | 'smbios'
  | 'host_broker'
  | 'user'
  | 'none';

export type ResourceSource = 'connector' | 'provider' | 'configured';
export type EnvironmentResourceMode = 'dedicated' | 'shared' | 'exclusive';

/**
 * An application-specific, account-scoped derivative. Raw hardware, operating
 * system, and provider identifiers are deliberately not representable here.
 */
export interface DerivedIdentityKey {
  key: string;
  version: number;
}

export interface ResourceProfile {
  architecture: string;
  operatingSystem: string;
  cpu: { model?: string; cores: number; limit?: number };
  memory: { totalBytes: number; availableBytes?: number; limitBytes?: number };
  storage: { totalBytes: number; availableBytes?: number };
  gpu?: Array<{ model: string; memoryBytes?: number }>;
  source: ResourceSource;
  reportedAt: string;
}

export interface ComputePlatformRecord {
  id: string;
  kind: ComputePlatformKind;
  name: string;
}

export interface ComputeHostRecord {
  id: string;
  identity: DerivedIdentityKey;
  name: string;
  platformId: string;
  resources?: ResourceProfile;
}

export type EnvironmentHostAssociation =
  | {
      evidence: Exclude<HostEvidence, 'none' | 'user'>;
      hostId: string;
      resolution: 'verified';
    }
  | {
      evidence: 'user';
      hostId: string;
      resolution: 'manual';
    }
  | {
      evidence: 'none';
      resolution: 'unresolved';
    }
  | {
      evidence: Exclude<HostEvidence, 'none'>;
      expectedHostId?: string;
      hostId?: string;
      resolution: 'conflict';
    }
  | {
      evidence: 'none' | 'provider';
      resolution: 'not_applicable';
    };

export interface ComputeEnvironmentRecord {
  hostAssociation: EnvironmentHostAssociation;
  id: string;
  identity: DerivedIdentityKey;
  kind: ComputeEnvironmentKind;
  name: string;
  parentEnvironmentId?: string;
  platformId: string;
  resourceMode: EnvironmentResourceMode;
  resources?: ResourceProfile;
}

/** A persisted connector always names exactly one immutable environment. */
export interface ConnectorEnvironmentAssociation {
  associatedAt: string;
  connectorId: string;
  environmentId: string;
}

export interface DerivedIdentityClaim {
  evidence: Exclude<HostEvidence, 'none' | 'user'>;
  identity: DerivedIdentityKey;
}

export type IdentityResolution =
  | { identity: DerivedIdentityKey; state: 'resolved' }
  | { state: 'unresolved' }
  | { identities: DerivedIdentityKey[]; state: 'conflict' };

export interface ComputeInventoryInput {
  connectors: readonly ConnectorEnvironmentAssociation[];
  environments: readonly ComputeEnvironmentRecord[];
  hosts: readonly ComputeHostRecord[];
  platforms: readonly ComputePlatformRecord[];
}

export interface ComputeEnvironmentNode {
  connectors: ConnectorEnvironmentAssociation[];
  children: ComputeEnvironmentNode[];
  environment: ComputeEnvironmentRecord;
}

export interface ComputeHostNode {
  environments: ComputeEnvironmentNode[];
  host: ComputeHostRecord;
}

export interface ComputePlatformNode {
  environments: ComputeEnvironmentNode[];
  hosts: ComputeHostNode[];
  platform: ComputePlatformRecord;
}

export interface ComputeInventory {
  platforms: ComputePlatformNode[];
}

export type ComputeInventoryViolationCode =
  | 'duplicate_connector'
  | 'duplicate_environment'
  | 'duplicate_environment_identity'
  | 'duplicate_host'
  | 'duplicate_host_identity'
  | 'duplicate_platform'
  | 'host_platform_missing'
  | 'environment_platform_missing'
  | 'environment_host_missing'
  | 'environment_host_platform_mismatch'
  | 'environment_parent_missing'
  | 'environment_parent_cycle'
  | 'environment_parent_platform_mismatch'
  | 'environment_parent_host_mismatch'
  | 'connector_environment_missing';

export interface ComputeInventoryViolation {
  code: ComputeInventoryViolationCode;
  id: string;
}

function identityId(identity: DerivedIdentityKey) {
  return `${identity.version}:${identity.key}`;
}

function scopedIdentityId(platformId: string, identity: DerivedIdentityKey) {
  return JSON.stringify([platformId, identity.version, identity.key]);
}

function associationHostId(association: EnvironmentHostAssociation) {
  return 'hostId' in association ? association.hostId : undefined;
}

function associationHostIds(association: EnvironmentHostAssociation) {
  const references = new Set<string>();
  if ('hostId' in association && association.hostId) references.add(association.hostId);
  if ('expectedHostId' in association && association.expectedHostId) {
    references.add(association.expectedHostId);
  }
  return [...references];
}

function duplicates(values: readonly string[]) {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return duplicate;
}

export function resolveDerivedIdentity(
  claims: readonly DerivedIdentityClaim[]
): IdentityResolution {
  const identities = new Map<string, DerivedIdentityKey>();
  for (const claim of claims) identities.set(identityId(claim.identity), claim.identity);
  const resolved = [...identities.values()].sort((left, right) =>
    identityId(left).localeCompare(identityId(right))
  );
  if (resolved.length === 0) return { state: 'unresolved' };
  if (resolved.length === 1) return { identity: resolved[0]!, state: 'resolved' };
  return { identities: resolved, state: 'conflict' };
}

export function hostAssociationLabel(association: EnvironmentHostAssociation) {
  switch (association.resolution) {
    case 'verified': return `Verified · ${association.evidence}`;
    case 'manual': return 'Manually assigned';
    case 'unresolved': return 'Needs assignment';
    case 'conflict': return 'Conflict · review required';
    case 'not_applicable': return 'Provider managed';
  }
}

export function validateComputeInventory(
  input: ComputeInventoryInput
): ComputeInventoryViolation[] {
  const violations: ComputeInventoryViolation[] = [];
  const platformIds = new Set(input.platforms.map(({ id }) => id));
  const hostsById = new Map(input.hosts.map((host) => [host.id, host]));
  const environmentsById = new Map(input.environments.map((environment) => [environment.id, environment]));

  for (const id of duplicates(input.platforms.map(({ id }) => id))) {
    violations.push({ code: 'duplicate_platform', id });
  }
  for (const id of duplicates(input.hosts.map(({ id }) => id))) {
    violations.push({ code: 'duplicate_host', id });
  }
  for (const id of duplicates(input.environments.map(({ id }) => id))) {
    violations.push({ code: 'duplicate_environment', id });
  }
  for (const id of duplicates(input.connectors.map(({ connectorId }) => connectorId))) {
    violations.push({ code: 'duplicate_connector', id });
  }
  for (const id of duplicates(input.hosts.map((host) => scopedIdentityId(host.platformId, host.identity)))) {
    violations.push({ code: 'duplicate_host_identity', id });
  }
  for (const id of duplicates(input.environments.map((environment) =>
    scopedIdentityId(environment.platformId, environment.identity)
  ))) {
    violations.push({ code: 'duplicate_environment_identity', id });
  }

  for (const host of input.hosts) {
    if (!platformIds.has(host.platformId)) {
      violations.push({ code: 'host_platform_missing', id: host.id });
    }
  }

  for (const environment of input.environments) {
    if (!platformIds.has(environment.platformId)) {
      violations.push({ code: 'environment_platform_missing', id: environment.id });
    }
    const hostId = associationHostId(environment.hostAssociation);
    const referencedHosts = associationHostIds(environment.hostAssociation)
      .map((referencedHostId) => hostsById.get(referencedHostId));
    if (referencedHosts.some((host) => !host)) {
      violations.push({ code: 'environment_host_missing', id: environment.id });
    }
    if (referencedHosts.some((host) => host && host.platformId !== environment.platformId)) {
      violations.push({ code: 'environment_host_platform_mismatch', id: environment.id });
    }
    if (environment.parentEnvironmentId) {
      const parent = environmentsById.get(environment.parentEnvironmentId);
      if (!parent) violations.push({ code: 'environment_parent_missing', id: environment.id });
      else {
        if (parent.platformId !== environment.platformId) {
          violations.push({ code: 'environment_parent_platform_mismatch', id: environment.id });
        }
        if (associationHostId(parent.hostAssociation) !== hostId) {
          violations.push({ code: 'environment_parent_host_mismatch', id: environment.id });
        }
      }
    }
  }

  for (const environment of input.environments) {
    const ancestors = new Set([environment.id]);
    let current = environment;
    while (current.parentEnvironmentId) {
      if (ancestors.has(current.parentEnvironmentId)) {
        violations.push({ code: 'environment_parent_cycle', id: environment.id });
        break;
      }
      ancestors.add(current.parentEnvironmentId);
      const parent = environmentsById.get(current.parentEnvironmentId);
      if (!parent) break;
      current = parent;
    }
  }

  for (const connector of input.connectors) {
    if (!environmentsById.has(connector.environmentId)) {
      violations.push({ code: 'connector_environment_missing', id: connector.connectorId });
    }
  }
  return violations.sort((left, right) =>
    left.code.localeCompare(right.code) || left.id.localeCompare(right.id)
  );
}

function environmentNodes(
  environments: readonly ComputeEnvironmentRecord[],
  connectors: readonly ConnectorEnvironmentAssociation[]
) {
  const connectorsByEnvironment = new Map<string, ConnectorEnvironmentAssociation[]>();
  for (const connector of connectors) {
    const entries = connectorsByEnvironment.get(connector.environmentId) ?? [];
    entries.push(connector);
    connectorsByEnvironment.set(connector.environmentId, entries);
  }
  const childrenByParent = new Map<string, ComputeEnvironmentRecord[]>();
  for (const environment of environments) {
    if (!environment.parentEnvironmentId) continue;
    const entries = childrenByParent.get(environment.parentEnvironmentId) ?? [];
    entries.push(environment);
    childrenByParent.set(environment.parentEnvironmentId, entries);
  }
  const node = (environment: ComputeEnvironmentRecord): ComputeEnvironmentNode => ({
    connectors: [...(connectorsByEnvironment.get(environment.id) ?? [])]
      .sort((left, right) => left.connectorId.localeCompare(right.connectorId)),
    children: [...(childrenByParent.get(environment.id) ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(node),
    environment
  });
  return environments
    .filter((environment) => !environment.parentEnvironmentId)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map(node);
}

export function groupComputeInventory(input: ComputeInventoryInput): ComputeInventory {
  const violations = validateComputeInventory(input);
  if (violations.length > 0) {
    throw new Error(`Invalid compute inventory: ${violations.map(({ code, id }) => `${code}:${id}`).join(', ')}`);
  }

  return {
    platforms: [...input.platforms]
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map((platform) => {
        const platformEnvironments = input.environments.filter(({ platformId }) => platformId === platform.id);
        const hostless = platformEnvironments.filter((environment) => !associationHostId(environment.hostAssociation));
        return {
          environments: environmentNodes(hostless, input.connectors),
          hosts: input.hosts
            .filter(({ platformId }) => platformId === platform.id)
            .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
            .map((host) => ({
              environments: environmentNodes(
                platformEnvironments.filter((environment) => associationHostId(environment.hostAssociation) === host.id),
                input.connectors
              ),
              host
            })),
          platform
        };
      })
  };
}

/**
 * Returns the capacity owner used by summaries. Host-backed and nested shared
 * environments collapse to one owner; dedicated provider environments remain
 * independently countable.
 */
export function resourceCapacityOwner(
  environment: ComputeEnvironmentRecord,
  environments: readonly ComputeEnvironmentRecord[]
): string {
  return resolveResourceCapacityOwner(environment, environments, new Set());
}

function resolveResourceCapacityOwner(
  environment: ComputeEnvironmentRecord,
  environments: readonly ComputeEnvironmentRecord[],
  visited: Set<string>
): string {
  const hostId = associationHostId(environment.hostAssociation);
  if (hostId) return `host:${hostId}`;
  if (environment.resourceMode !== 'shared') return `environment:${environment.id}`;
  if (environment.parentEnvironmentId) {
    if (visited.has(environment.id)) throw new Error('Environment parent cycle');
    visited.add(environment.id);
    const parent = environments.find(({ id }) => id === environment.parentEnvironmentId);
    if (parent) return resolveResourceCapacityOwner(parent, environments, visited);
  }
  return `platform:${environment.platformId}:shared`;
}
