import { createHash } from 'node:crypto';

import type {
  ComputeEnvironmentRecord,
  ComputeHostRecord,
  ComputeInventorySnapshot,
  ComputePlatformRecord,
  ConnectorComputeMetadata,
  ConnectorEnvironmentAssociation,
  EnvironmentDefinitionRecord
} from '../src/shared/compute-environment-api';
import {
  builtInEnvironmentDefinition,
  validateComputeInventory
} from '../src/shared/compute-environment-api';
import type { MachineRecord, PhysicalMachineRecord } from '../src/shared/project-space-api';

function stableId(namespace: string, value: string) {
  return `${namespace}-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}

function legacyMetadata(machine: MachineRecord): ConnectorComputeMetadata {
  const environmentKind = machine.environment?.kind === 'macos'
    ? 'native_macos'
    : machine.environment?.kind === 'windows'
      ? 'native_windows'
      : machine.environment?.kind === 'wsl'
        ? 'wsl'
        : machine.environment?.kind === 'linux'
          ? 'native_linux'
          : 'other';
  return {
    environmentIdentity: {
      key: `connector:${createHash('sha256').update(machine.id, 'utf8').digest('hex')}`,
      version: 1
    },
    environmentKind,
    environmentName: machine.environment?.label || machine.name,
    hostEvidence: 'none',
    hostResolution: 'unresolved',
    platformKind: 'local',
    platformName: 'Local & self-hosted',
    resourceMode: 'dedicated'
  };
}

function identityKey(version: number, key: string) {
  return `${version}:${key}`;
}

export function computeInventoryFromConnectors(input: {
  connectors: readonly MachineRecord[];
  physicalMachines?: readonly PhysicalMachineRecord[];
}): ComputeInventorySnapshot {
  const platformsByKey = new Map<string, ComputePlatformRecord>();
  const hostsById = new Map<string, ComputeHostRecord>();
  const environmentDefinitionsByKind = new Map<string, EnvironmentDefinitionRecord>();
  const environmentsByKey = new Map<string, ComputeEnvironmentRecord>();
  const connectors: ConnectorEnvironmentAssociation[] = [];
  const physicalByConnector = new Map<string, PhysicalMachineRecord[]>();

  for (const machine of input.physicalMachines ?? []) {
    for (const connectorId of machine.connectorIds) {
      const entries = physicalByConnector.get(connectorId) ?? [];
      entries.push(machine);
      physicalByConnector.set(connectorId, entries);
    }
  }

  for (const connector of input.connectors) {
    const metadata = connector.compute ?? legacyMetadata(connector);
    const environmentDefinition = definitionForKind(
      metadata.environmentKind,
      environmentDefinitionsByKind
    );
    const platformKey = `${metadata.platformKind}:${metadata.platformName}`;
    let platform = platformsByKey.get(platformKey);
    if (!platform) {
      platform = {
        id: stableId('platform', platformKey),
        kind: metadata.platformKind,
        name: metadata.platformName
      };
      platformsByKey.set(platformKey, platform);
    }

    let hostAssociation: ComputeEnvironmentRecord['hostAssociation'];
    if (metadata.hostResolution === 'not_applicable') {
      hostAssociation = { evidence: metadata.hostEvidence === 'provider' ? 'provider' : 'none', resolution: 'not_applicable' };
    } else if (metadata.hostIdentity && metadata.hostName && metadata.hostResolution === 'verified') {
      const hostId = stableId('host', `${platform.id}:${identityKey(metadata.hostIdentity.version, metadata.hostIdentity.key)}`);
      hostsById.set(hostId, {
        id: hostId,
        identity: metadata.hostIdentity,
        name: metadata.hostName,
        platformId: platform.id,
        resources: metadata.resourceMode === 'exclusive' ? metadata.resources : undefined
      });
      hostAssociation = { evidence: metadata.hostEvidence as 'provider' | 'tpm' | 'smbios' | 'host_broker', hostId, resolution: 'verified' };
    } else {
      const manual = physicalByConnector.get(connector.id) ?? [];
      if (manual.length === 1) {
        const physical = manual[0]!;
        const hostId = stableId('host', `${platform.id}:manual:${physical.id}`);
        hostsById.set(hostId, {
          id: hostId,
          identity: { key: `manual:${createHash('sha256').update(physical.id).digest('hex')}`, version: 1 },
          name: physical.name,
          platformId: platform.id
        });
        hostAssociation = { evidence: 'user', hostId, resolution: 'manual' };
      } else if (manual.length > 1) {
        hostAssociation = { evidence: 'user', resolution: 'conflict' };
      } else {
        hostAssociation = { evidence: 'none', resolution: 'unresolved' };
      }
    }

    const environmentKey = `${platform.id}:${identityKey(
      metadata.environmentIdentity.version,
      metadata.environmentIdentity.key
    )}`;
    let parentEnvironmentId: string | undefined;
    if (metadata.parentEnvironmentIdentity) {
      const parentKey = `${platform.id}:${identityKey(
        metadata.parentEnvironmentIdentity.version,
        metadata.parentEnvironmentIdentity.key
      )}`;
      let parent = environmentsByKey.get(parentKey);
      if (!parent) {
        parent = {
          environmentDefinitionId: definitionForKind(
            'other',
            environmentDefinitionsByKind
          ).id,
          hostAssociation,
          id: stableId('environment', parentKey),
          identity: metadata.parentEnvironmentIdentity,
          kind: 'other',
          name: `${metadata.environmentName} parent`,
          platformId: platform.id,
          resourceMode: 'shared'
        };
        environmentsByKey.set(parentKey, parent);
      }
      parentEnvironmentId = parent.id;
    }
    let environment = environmentsByKey.get(environmentKey);
    if (!environment) {
      environment = {
        environmentDefinitionId: environmentDefinition.id,
        hostAssociation,
        id: stableId('environment', environmentKey),
        identity: metadata.environmentIdentity,
        kind: metadata.environmentKind,
        name: metadata.environmentName,
        parentEnvironmentId,
        platformId: platform.id,
        resourceMode: metadata.resourceMode,
        resources: metadata.resourceMode === 'exclusive' ? undefined : metadata.resources
      };
      environmentsByKey.set(environmentKey, environment);
    } else if (JSON.stringify(environment.hostAssociation) !== JSON.stringify(hostAssociation)) {
      environment.hostAssociation = { evidence: 'user', resolution: 'conflict' };
    }
    connectors.push({
      associatedAt: connector.connector.lastSeen ?? new Date(0).toISOString(),
      connectorId: connector.id,
      environmentId: environment.id
    });
  }

  const snapshot = {
    connectors,
    environmentDefinitions: [...environmentDefinitionsByKind.values()],
    environments: [...environmentsByKey.values()],
    hosts: [...hostsById.values()],
    platforms: [...platformsByKey.values()]
  };
  return { ...snapshot, violations: validateComputeInventory(snapshot) };
}

function definitionForKind(
  kind: ComputeEnvironmentRecord['kind'],
  definitions: Map<string, EnvironmentDefinitionRecord>
) {
  const current = definitions.get(kind);
  if (current) return current;
  const definition = {
    ...builtInEnvironmentDefinition(kind),
    id: stableId('environment-definition', kind)
  };
  definitions.set(kind, definition);
  return definition;
}
