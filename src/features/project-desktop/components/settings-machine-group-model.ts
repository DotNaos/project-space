import type {
  ConnectorCredentialRecord,
  ConnectorInstallationRecord,
  PhysicalMachineRecord
} from '@/shared/project-space-api';
import {
  connectorEnvironmentLabel,
  connectorRuntimeLabel
} from './machine-connector-topology-model';

export type SettingsConnectorChannel = 'dev' | 'stable';

export interface SettingsConnectorCredentials {
  archived: ConnectorCredentialRecord[];
  current: ConnectorCredentialRecord[];
}

export interface SettingsConnectorInstance {
  channel: SettingsConnectorChannel;
  credentials: SettingsConnectorCredentials;
  id: string;
  isOnline: boolean;
  machine: ConnectorInstallationRecord;
  platformLabel?: string;
  runtimeLabel: string;
}

export interface SettingsMachineGroup {
  archivedConnectorCount: number;
  archivedInstances: SettingsConnectorInstance[];
  connectorCount: number;
  id: string;
  instances: SettingsConnectorInstance[];
  connectorIds: string[];
  kind: PhysicalMachineRecord['kind'];
  name: string;
  onlineConnectorCount: number;
  platformLabels: string[];
}

export interface SettingsMachineScopeConflict {
  machineId: string;
  scopeIds: string[];
}

export interface SettingsMachineGroupingResult {
  archivedUnscopedInstances: SettingsConnectorInstance[];
  groups: SettingsMachineGroup[];
  scopeConflicts: SettingsMachineScopeConflict[];
  unmatchedCredentials: ConnectorCredentialRecord[];
  unscopedInstances: SettingsConnectorInstance[];
}

export interface SettingsMachineGroupingInput {
  connectors: readonly ConnectorInstallationRecord[];
  credentials?: readonly ConnectorCredentialRecord[];
  physicalMachines: readonly PhysicalMachineRecord[];
}

export function safeConnectorOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

const currentCredentialStatuses = new Set<ConnectorCredentialRecord['status']>([
  'active',
  'pending'
]);

function connectorChannel(machine: ConnectorInstallationRecord): SettingsConnectorChannel {
  return machine.connector.profile?.channel === 'dev' &&
    machine.connector.profile.source === 'source'
    ? 'dev'
    : 'stable';
}

function connectorIsOnline(machine: ConnectorInstallationRecord) {
  return machine.connector.status === 'local' || machine.connector.status === 'online';
}

function credentialsForMachine(
  machineId: string,
  credentialsByMachineId: ReadonlyMap<string, readonly ConnectorCredentialRecord[]>
): SettingsConnectorCredentials {
  const credentials = credentialsByMachineId.get(machineId) ?? [];
  const current: ConnectorCredentialRecord[] = [];
  const archived: ConnectorCredentialRecord[] = [];

  for (const credential of credentials) {
    (currentCredentialStatuses.has(credential.status) ? current : archived).push(credential);
  }

  return {
    archived: archived.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    current: current.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  };
}

function connectorInstance(
  machine: ConnectorInstallationRecord,
  credentialsByMachineId: ReadonlyMap<string, readonly ConnectorCredentialRecord[]>
): SettingsConnectorInstance {
  const channel = connectorChannel(machine);
  return {
    channel,
    credentials: credentialsForMachine(machine.id, credentialsByMachineId),
    id: machine.id,
    isOnline: connectorIsOnline(machine),
    machine,
    platformLabel: connectorEnvironmentLabel(machine),
    runtimeLabel: connectorRuntimeLabel(machine)
  };
}

function isProvenArchived(instance: SettingsConnectorInstance) {
  return (
    !instance.isOnline &&
    instance.credentials.current.length === 0 &&
    instance.credentials.archived.length > 0
  );
}

function compareInstances(left: SettingsConnectorInstance, right: SettingsConnectorInstance) {
  const channelOrder = Number(left.channel === 'dev') - Number(right.channel === 'dev');
  if (channelOrder !== 0) return channelOrder;

  const onlineOrder = Number(right.isOnline) - Number(left.isOnline);
  return onlineOrder !== 0 ? onlineOrder : left.id.localeCompare(right.id);
}

function splitInstances(instances: readonly SettingsConnectorInstance[]) {
  const active: SettingsConnectorInstance[] = [];
  const archived: SettingsConnectorInstance[] = [];
  for (const instance of instances) {
    (isProvenArchived(instance) ? archived : active).push(instance);
  }
  return {
    active: active.sort(compareInstances),
    archived: archived.sort(compareInstances)
  };
}

function machineGroup(
  physicalMachine: PhysicalMachineRecord,
  instances: readonly SettingsConnectorInstance[]
): SettingsMachineGroup {
  const split = splitInstances(instances);

  const allInstances = [...split.active, ...split.archived];
  return {
    archivedConnectorCount: split.archived.length,
    archivedInstances: split.archived,
    connectorCount: split.active.length,
    id: physicalMachine.id,
    instances: split.active,
    connectorIds: [...new Set(physicalMachine.connectorIds)],
    kind: physicalMachine.kind,
    name: physicalMachine.name,
    onlineConnectorCount: split.active.filter((instance) => instance.isOnline).length,
    platformLabels: [...new Set(allInstances.flatMap((instance) => (
      instance.platformLabel ? [instance.platformLabel] : []
    )))]
  };
}

export function groupSettingsMachines({
  connectors,
  credentials = [],
  physicalMachines
}: SettingsMachineGroupingInput): SettingsMachineGroupingResult {
  const machinesById = new Map(connectors.map((machine) => [machine.id, machine]));
  const credentialsByMachineId = new Map<string, ConnectorCredentialRecord[]>();
  const unmatchedCredentials: ConnectorCredentialRecord[] = [];

  for (const credential of credentials) {
    if (!credential.machineId || !machinesById.has(credential.machineId)) {
      unmatchedCredentials.push(credential);
      continue;
    }
    const entries = credentialsByMachineId.get(credential.machineId) ?? [];
    entries.push(credential);
    credentialsByMachineId.set(credential.machineId, entries);
  }

  const instancesById = new Map(
    connectors.map((machine) => [machine.id, connectorInstance(machine, credentialsByMachineId)])
  );
  const scopeIdsByMachineId = new Map<string, string[]>();
  for (const physicalMachine of physicalMachines) {
    for (const machineId of new Set(physicalMachine.connectorIds)) {
      const scopeIds = scopeIdsByMachineId.get(machineId) ?? [];
      scopeIds.push(physicalMachine.id);
      scopeIdsByMachineId.set(machineId, scopeIds);
    }
  }

  const scopeConflicts: SettingsMachineScopeConflict[] = [];
  const unscoped: SettingsConnectorInstance[] = [];
  for (const instance of instancesById.values()) {
    const scopeIds = scopeIdsByMachineId.get(instance.id) ?? [];
    if (scopeIds.length === 1) continue;
    unscoped.push(instance);
    if (scopeIds.length > 1) {
      scopeConflicts.push({ machineId: instance.id, scopeIds: [...scopeIds].sort() });
    }
  }

  const groups = physicalMachines.map((physicalMachine) => {
    const instances = [...new Set(physicalMachine.connectorIds)].flatMap((machineId) => {
      const memberships = scopeIdsByMachineId.get(machineId) ?? [];
      const instance = instancesById.get(machineId);
      return instance && memberships.length === 1 ? [instance] : [];
    });
    return machineGroup(physicalMachine, instances);
  });
  const splitUnscoped = splitInstances(unscoped);

  return {
    archivedUnscopedInstances: splitUnscoped.archived,
    groups,
    scopeConflicts: scopeConflicts.sort((left, right) => left.machineId.localeCompare(right.machineId)),
    unmatchedCredentials: unmatchedCredentials.sort((left, right) => left.id.localeCompare(right.id)),
    unscopedInstances: splitUnscoped.active
  };
}
