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
  identityResolution?: 'resolved' | 'conflict';
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

/** Privacy-preserving topology evidence reported by one connector runtime. */
export interface ConnectorComputeMetadata {
  environmentIdentity: DerivedIdentityKey;
  environmentKind: ComputeEnvironmentKind;
  environmentName: string;
  hostEvidence: HostEvidence;
  hostIdentity?: DerivedIdentityKey;
  hostName?: string;
  hostResolution: HostResolution;
  parentEnvironmentIdentity?: DerivedIdentityKey;
  platformKind: ComputePlatformKind;
  platformName: string;
  resourceMode: EnvironmentResourceMode;
  resources?: ResourceProfile;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function finiteNonNegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isDerivedIdentityKey(value: unknown): value is DerivedIdentityKey {
  return record(value) && onlyKeys(value, ['key', 'version']) &&
    typeof value.key === 'string' && /^[A-Za-z0-9:_-]{8,256}$/.test(value.key) &&
    Number.isSafeInteger(value.version) && Number(value.version) > 0;
}

export function isResourceProfile(value: unknown): value is ResourceProfile {
  if (!record(value) || !onlyKeys(value, [
    'architecture', 'operatingSystem', 'cpu', 'memory', 'storage', 'gpu',
    'source', 'reportedAt'
  ])) return false;
  if (!record(value.cpu) || !onlyKeys(value.cpu, ['model', 'cores', 'limit']) ||
    !Number.isSafeInteger(value.cpu.cores) || Number(value.cpu.cores) <= 0 ||
    (value.cpu.limit !== undefined && !finiteNonNegative(value.cpu.limit)) ||
    (value.cpu.model !== undefined && (typeof value.cpu.model !== 'string' || value.cpu.model.length > 256))) {
    return false;
  }
  if (!record(value.memory) || !onlyKeys(value.memory, ['totalBytes', 'availableBytes', 'limitBytes']) ||
    !finiteNonNegative(value.memory.totalBytes) ||
    (value.memory.availableBytes !== undefined && !finiteNonNegative(value.memory.availableBytes)) ||
    (value.memory.limitBytes !== undefined && !finiteNonNegative(value.memory.limitBytes))) {
    return false;
  }
  if (!record(value.storage) || !onlyKeys(value.storage, ['totalBytes', 'availableBytes']) ||
    !finiteNonNegative(value.storage.totalBytes) ||
    (value.storage.availableBytes !== undefined && !finiteNonNegative(value.storage.availableBytes))) {
    return false;
  }
  if (value.gpu !== undefined && (!Array.isArray(value.gpu) || value.gpu.length > 16 ||
    value.gpu.some((gpu) => !record(gpu) || !onlyKeys(gpu, ['model', 'memoryBytes']) ||
      typeof gpu.model !== 'string' || !gpu.model || gpu.model.length > 256 ||
      (gpu.memoryBytes !== undefined && !finiteNonNegative(gpu.memoryBytes))))) {
    return false;
  }
  return typeof value.architecture === 'string' && value.architecture.length <= 64 &&
    typeof value.operatingSystem === 'string' && value.operatingSystem.length <= 128 &&
    ['connector', 'provider', 'configured'].includes(String(value.source)) &&
    typeof value.reportedAt === 'string' && Number.isFinite(Date.parse(value.reportedAt));
}

export function isConnectorComputeMetadataValue(
  value: unknown
): value is ConnectorComputeMetadata {
  if (!record(value) || !onlyKeys(value, [
    'environmentIdentity', 'environmentKind', 'environmentName', 'hostEvidence',
    'hostIdentity', 'hostName', 'hostResolution', 'parentEnvironmentIdentity', 'platformKind', 'platformName',
    'resourceMode', 'resources'
  ])) return false;
  const hostIdentity = value.hostIdentity;
  const hostName = value.hostName;
  const hostEvidence = String(value.hostEvidence);
  const hostResolution = String(value.hostResolution);
  const hasHost = hostIdentity !== undefined && hostName !== undefined;
  const consistentHostAssociation =
    (hostResolution === 'verified' && hasHost &&
      ['provider', 'tpm', 'smbios', 'host_broker'].includes(hostEvidence)) ||
    (hostResolution === 'manual' && hasHost && hostEvidence === 'user') ||
    (hostResolution === 'unresolved' && !hasHost && hostEvidence === 'none') ||
    (hostResolution === 'conflict' && hostEvidence !== 'none') ||
    (hostResolution === 'not_applicable' && !hasHost &&
      ['none', 'provider'].includes(hostEvidence));
  return consistentHostAssociation && isDerivedIdentityKey(value.environmentIdentity) &&
    (value.hostIdentity === undefined || isDerivedIdentityKey(value.hostIdentity)) &&
    (value.parentEnvironmentIdentity === undefined || isDerivedIdentityKey(value.parentEnvironmentIdentity)) &&
    ['local', 'github_codespaces', 'cloud_sandbox', 'kubernetes', 'virtualization', 'other']
      .includes(String(value.platformKind)) &&
    [
      'native_macos', 'native_windows', 'native_linux', 'wsl', 'docker', 'devbox',
      'github_codespace', 'cloud_sandbox', 'kubernetes_workload', 'virtual_machine', 'other'
    ].includes(String(value.environmentKind)) &&
    typeof value.platformName === 'string' && value.platformName.length > 0 && value.platformName.length <= 80 &&
    typeof value.environmentName === 'string' && value.environmentName.length > 0 && value.environmentName.length <= 128 &&
    (value.hostName === undefined || (
      typeof value.hostName === 'string' && value.hostName.length > 0 && value.hostName.length <= 80
    )) &&
    ['provider', 'tpm', 'smbios', 'host_broker', 'user', 'none'].includes(String(value.hostEvidence)) &&
    ['verified', 'manual', 'unresolved', 'conflict', 'not_applicable'].includes(String(value.hostResolution)) &&
    ['dedicated', 'shared', 'exclusive'].includes(String(value.resourceMode)) &&
    (value.resources === undefined || isResourceProfile(value.resources));
}

export interface ComputeInventorySnapshot extends ComputeInventoryInput {
  violations: ComputeInventoryViolation[];
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
 * Returns the capacity owner used by summaries. Exclusive native environments
 * count at their host, dedicated environments count their own allocation, and
 * nested shared environments collapse to their parent capacity owner.
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
  if (environment.resourceMode === 'exclusive') {
    return hostId ? `host:${hostId}` : `environment:${environment.id}`;
  }
  if (environment.resourceMode === 'dedicated') return `environment:${environment.id}`;
  if (hostId) return `host:${hostId}`;
  if (environment.parentEnvironmentId) {
    if (visited.has(environment.id)) throw new Error('Environment parent cycle');
    visited.add(environment.id);
    const parent = environments.find(({ id }) => id === environment.parentEnvironmentId);
    if (parent) return resolveResourceCapacityOwner(parent, environments, visited);
  }
  return `platform:${environment.platformId}:shared`;
}
