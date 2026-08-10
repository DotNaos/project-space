import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type {
  ComputeEnvironmentRecord,
  ComputeInventoryViolation,
  ResourceProfile
} from '../../src/shared/compute-environment-api';
import { resourceCapacityOwner } from '../../src/shared/compute-environment-api';
import type { MachineRecord } from '../../src/shared/project-space-api';
import type { ConfiguredComputeInventoryResult } from '../configured-compute-inventory';
import type {
  ExecutionEnvironmentLifecycleBindingProjection,
  ExecutionEnvironmentLifecycleService
} from '../execution-environment-lifecycle/service';
import { currentRequestId } from '../observability';
import { toolSchemas } from './tool-catalog';
import { toolError, toolResult } from './results';

const agentEvidenceFreshForMs = 5 * 60_000;

export type LoadMcpComputeInventory = (
  userId: string
) => Promise<ConfiguredComputeInventoryResult>;

export async function callComputeEnvironmentTool(input: {
  loadInventory: LoadMcpComputeInventory;
  lifecycle?: ExecutionEnvironmentLifecycleService;
  name: string;
  rawArguments: Record<string, unknown>;
  userId: string;
}): Promise<CallToolResult | undefined> {
  if (input.name === 'list_execution_environments') {
    const filters = toolSchemas.list_execution_environments.parse(input.rawArguments);
    const bindings = await input.lifecycle?.list(input.userId) ?? [];
    return toolResult(overlayProviderBindings(
      projectExecutionEnvironments(await input.loadInventory(input.userId), filters),
      bindings
    ));
  }
  if (input.name === 'get_execution_environment') {
    const selector = toolSchemas.get_execution_environment.parse(input.rawArguments);
    let bindings = await input.lifecycle?.list(input.userId) ?? [];
    if (input.lifecycle && bindings.some(({ environmentId }) => environmentId === selector.environmentId)) {
      await input.lifecycle.status({ userId: input.userId }, selector.environmentId);
      bindings = await input.lifecycle.list(input.userId);
    }
    const result = overlayProviderBindings(
      projectExecutionEnvironments(await input.loadInventory(input.userId), {}),
      bindings
    );
    const environment = result.environments.find(({ id }) => id === selector.environmentId);
    return environment
      ? toolResult({
          checkedAt: result.checkedAt,
          environment,
          inventoryState: result.inventoryState,
          violations: result.violations
        })
      : toolError('The execution Environment was not found.', currentRequestId());
  }
  return undefined;
}

function overlayProviderBindings<Result extends ReturnType<typeof projectExecutionEnvironments>>(
  result: Result,
  bindings: ExecutionEnvironmentLifecycleBindingProjection[]
) {
  const byEnvironment = new Map(bindings
    .filter((binding): binding is typeof binding & { environmentId: string } => Boolean(binding.environmentId))
    .map((binding) => [binding.environmentId, binding]));
  return {
    ...result,
    environments: result.environments.map((environment) => {
      const binding = byEnvironment.get(environment.id);
      if (!binding) return environment;
      const normalized = binding.lifecycle.normalized;
      return {
        ...environment,
        providerLifecycle: binding.lifecycle,
        supportedLifecycleActions: normalized === 'deleted'
          ? []
          : normalized === 'stopped'
            ? ['start', 'delete']
            : normalized === 'running'
              ? ['stop']
              : ['status']
      };
    })
  };
}

export function projectExecutionEnvironments(
  inventory: ConfiguredComputeInventoryResult,
  filters: { capability?: string; kind?: ComputeEnvironmentRecord['kind']; platform?: string }
) {
  const platforms = new Map(inventory.snapshot.platforms.map((platform) => [platform.id, platform]));
  const hosts = new Map(inventory.snapshot.hosts.map((host) => [host.id, host]));
  const connectors = new Map(inventory.connectors.map((connector) => [connector.id, connector]));
  const associations = new Map<
    string,
    Array<ConfiguredComputeInventoryResult['snapshot']['connectors'][number]>
  >();
  for (const association of inventory.snapshot.connectors) {
    const entries = associations.get(association.environmentId) ?? [];
    entries.push(association);
    associations.set(association.environmentId, entries);
  }

  const environments = inventory.snapshot.environments
    .map((environment) => {
      const inventoryConflict = inventory.snapshot.violations.length > 0;
      const platform = platforms.get(environment.platformId);
      const environmentAssociations = associations.get(environment.id) ?? [];
      const associatedMachines = environmentAssociations
        .map(({ connectorId }) => connectors.get(connectorId))
        .filter((connector): connector is MachineRecord => Boolean(connector));
      const connectorRecords = environmentAssociations
        .map((association) => connectorProjection(
          association,
          connectors.get(association.connectorId),
          inventory.generations.get(association.connectorId)
        ))
        .sort((left, right) => left.id.localeCompare(right.id));
      const onlineConnectors = connectorRecords.filter(({ status }) => isActive(status));
      const activeConnectors = onlineConnectors.filter(({ generation }) => generation !== undefined);
      const agentRuntimes = agentRuntimeSummaries(
        associatedMachines,
        inventory.generations,
        inventory.checkedAt
      );
      const hostId = 'hostId' in environment.hostAssociation
        ? environment.hostAssociation.hostId
        : undefined;
      const host = hostId ? hosts.get(hostId) : undefined;
      return {
        agentRuntimes,
        capacity: {
          ownerId: inventoryConflict
            ? undefined
            : resourceCapacityOwner(environment, inventory.snapshot.environments),
          state: 'unknown' as const
        },
        connectors: connectorRecords,
        hostAssociation: {
          evidence: environment.hostAssociation.evidence,
          host: host ? {
            id: host.id,
            name: host.name,
            resources: resourceProjection(host.resources)
          } : undefined,
          resolution: environment.hostAssociation.resolution
        },
        id: environment.id,
        identityState: environment.identityResolution ?? 'resolved',
        kind: environment.kind,
        name: environment.name,
        parentEnvironmentId: environment.parentEnvironmentId,
        platform: platform ? { id: platform.id, kind: platform.kind, name: platform.name } : {
          id: environment.platformId,
          kind: 'other' as const,
          name: 'Unknown platform'
        },
        providerLifecycle: {
          state: platform?.kind === 'local' ? 'unmanaged' as const : 'unknown' as const
        },
        readiness: readiness(
          environment,
          platform?.kind !== 'local',
          inventoryConflict,
          connectorRecords.length,
          onlineConnectors.length,
          activeConnectors,
          agentRuntimes
        ),
        resourceMode: environment.resourceMode,
        resources: resourceProjection(environment.resources),
        supportedLifecycleActions: [] as string[]
      };
    })
    .filter((environment) => (
      (!filters.kind || environment.kind === filters.kind) &&
      (!filters.platform || [environment.platform.id, environment.platform.kind].includes(filters.platform)) &&
      (!filters.capability || environment.connectors.some((connector) => (
        isActive(connector.status) && connector.generation !== undefined &&
        connector.capabilities.includes(filters.capability!)
      )))
    ))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  return {
    checkedAt: inventory.checkedAt,
    environments,
    inventoryState: inventory.snapshot.violations.length === 0 ? 'ready' as const : 'conflict' as const,
    violations: inventory.snapshot.violations.map(violationProjection)
  };
}

function connectorProjection(
  association: ConfiguredComputeInventoryResult['snapshot']['connectors'][number],
  connector: MachineRecord | undefined,
  generation: number | undefined
) {
  return {
    associatedAt: association.associatedAt,
    capabilities: [...(connector?.connector.capabilities ?? [])].sort(),
    generation,
    id: association.connectorId,
    lastSeen: connector?.connector.lastSeen,
    name: connector?.name,
    status: connector?.connector.status ?? 'offline'
  };
}

function readiness(
  environment: ComputeEnvironmentRecord,
  providerEvidenceRequired: boolean,
  inventoryConflict: boolean,
  associatedCount: number,
  onlineCount: number,
  activeConnectors: Array<{ id: string }>,
  agentRuntimes: Array<{
    authorization: { state: string };
    connectorId: string;
    state: string;
  }>
) {
  if (
    inventoryConflict ||
    environment.identityResolution === 'conflict' ||
    environment.hostAssociation.resolution === 'conflict'
  ) {
    return { state: 'conflict' as const };
  }
  if (activeConnectors.length === 1) {
    const connectorId = activeConnectors[0]!.id;
    const runtime = agentRuntimes.find((entry) => entry.connectorId === connectorId);
    return {
      pendingEvidence: [
        ...(providerEvidenceRequired ? ['provider_lifecycle'] : []),
        ...(runtime?.state === 'ready' ? [] : ['agent_runtime']),
        ...(runtime?.authorization.state === 'ready' ? [] : ['agent_authorization']),
        'workspace',
        'capacity'
      ],
      selectedConnectorId: connectorId,
      state: 'checking' as const
    };
  }
  if (activeConnectors.length > 1) {
    return { connectorIds: activeConnectors.map(({ id }) => id), state: 'connector_selection_required' as const };
  }
  if (onlineCount > 0) return { state: 'stale_connector' as const };
  return { state: associatedCount > 0 ? 'offline' as const : 'unavailable' as const };
}

function agentRuntimeSummaries(
  connectors: MachineRecord[],
  generations: ReadonlyMap<string, number>,
  inventoryCheckedAt: string
) {
  return connectors
    .filter((connector) => (
      connector.connector.daemon ||
      connector.connector.capabilities?.some((capability) => capability.startsWith('codex.'))
    ))
    .map((connector) => {
      const daemon = connector.connector.daemon;
      const offline = !isActive(connector.connector.status);
      const stale = !offline && !generations.has(connector.id);
      const fresh = daemonEvidenceIsFresh(daemon?.checkedAt, inventoryCheckedAt);
      const authorizationState = offline
        ? 'offline' as const
        : stale
          ? 'unknown' as const
        : !fresh
          ? 'unknown' as const
        : daemon?.authenticated
          ? 'ready' as const
          : daemon?.state === 'authorization-required'
            ? 'authorization-required' as const
            : daemon?.state === 'unsupported'
              ? 'unsupported' as const
              : 'unknown' as const;
      return {
        authorization: {
          checkedAt: daemon?.checkedAt,
          state: authorizationState
        },
        checkedAt: daemon?.checkedAt,
        connectorId: connector.id,
        generation: generations.get(connector.id),
        kind: 'codex' as const,
        state: offline
          ? 'offline' as const
          : stale
            ? 'stale_connector' as const
            : daemon && !fresh
              ? 'stale_evidence' as const
            : daemon?.state ?? 'unknown' as const,
        version: daemon?.cliVersion
      };
    })
    .sort((left, right) => left.connectorId.localeCompare(right.connectorId));
}

function daemonEvidenceIsFresh(checkedAt: string | undefined, inventoryCheckedAt: string) {
  if (!checkedAt) return false;
  const evidenceTime = Date.parse(checkedAt);
  const inventoryTime = Date.parse(inventoryCheckedAt);
  return Number.isFinite(evidenceTime) && Number.isFinite(inventoryTime) &&
    evidenceTime <= inventoryTime + agentEvidenceFreshForMs &&
    inventoryTime - evidenceTime <= agentEvidenceFreshForMs;
}

function resourceProjection(resources?: ResourceProfile) {
  return resources ? {
    architecture: resources.architecture,
    cpu: { cores: resources.cpu.cores, limit: resources.cpu.limit },
    memory: resources.memory,
    operatingSystem: resources.operatingSystem,
    reportedAt: resources.reportedAt,
    source: resources.source,
    storage: resources.storage
  } : undefined;
}

function violationProjection(violation: ComputeInventoryViolation) {
  return violation.code.endsWith('_identity')
    ? { code: violation.code }
    : { code: violation.code, subjectId: violation.id };
}

function isActive(status: string) {
  return status === 'local' || status === 'online';
}
