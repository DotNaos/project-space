import type {
  ConnectorCredentialRecord,
  MachineExecutionScopeRecord,
  MachineRecord
} from '@/shared/project-space-api';

export type SettingsConnectorChannel = 'dev' | 'stable';

export interface SettingsConnectorCredentials {
  archived: ConnectorCredentialRecord[];
  current: ConnectorCredentialRecord[];
}

export interface SettingsConnectorInstance {
  channel: SettingsConnectorChannel;
  channelLabel: 'Dev' | 'Stable';
  credentials: SettingsConnectorCredentials;
  id: string;
  isOnline: boolean;
  machine: MachineRecord;
  platformLabel: string;
}

export interface SettingsMachineGroup {
  archivedConnectorCount: number;
  archivedInstances: SettingsConnectorInstance[];
  connectorCount: number;
  id: string;
  instances: SettingsConnectorInstance[];
  machineIds: string[];
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
  credentials?: readonly ConnectorCredentialRecord[];
  machines: readonly MachineRecord[];
  scopes: readonly MachineExecutionScopeRecord[];
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

function connectorChannel(machine: MachineRecord): SettingsConnectorChannel {
  return machine.connector.profile?.channel === 'dev' &&
    machine.connector.profile.source === 'source'
    ? 'dev'
    : 'stable';
}

function connectorIsOnline(machine: MachineRecord) {
  return machine.connector.status === 'local' || machine.connector.status === 'online';
}

function platformLabel(machine: MachineRecord) {
  const platform = machine.connector.runtime?.platform;
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'windows') return 'Windows';
  return 'Unknown platform';
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
  machine: MachineRecord,
  credentialsByMachineId: ReadonlyMap<string, readonly ConnectorCredentialRecord[]>
): SettingsConnectorInstance {
  const channel = connectorChannel(machine);
  return {
    channel,
    channelLabel: channel === 'dev' ? 'Dev' : 'Stable',
    credentials: credentialsForMachine(machine.id, credentialsByMachineId),
    id: machine.id,
    isOnline: connectorIsOnline(machine),
    machine,
    platformLabel: platformLabel(machine)
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
  scope: MachineExecutionScopeRecord,
  instances: readonly SettingsConnectorInstance[]
): SettingsMachineGroup | undefined {
  const split = splitInstances(instances);
  if (split.active.length === 0 && split.archived.length === 0) return undefined;

  const allInstances = [...split.active, ...split.archived];
  return {
    archivedConnectorCount: split.archived.length,
    archivedInstances: split.archived,
    connectorCount: split.active.length,
    id: scope.id,
    instances: split.active,
    machineIds: [...new Set(scope.machineIds)],
    name: scope.name,
    onlineConnectorCount: split.active.filter((instance) => instance.isOnline).length,
    platformLabels: [...new Set(allInstances.map((instance) => instance.platformLabel))]
  };
}

export function groupSettingsMachines({
  credentials = [],
  machines,
  scopes
}: SettingsMachineGroupingInput): SettingsMachineGroupingResult {
  const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
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
    machines.map((machine) => [machine.id, connectorInstance(machine, credentialsByMachineId)])
  );
  const scopeIdsByMachineId = new Map<string, string[]>();
  for (const scope of scopes) {
    for (const machineId of new Set(scope.machineIds)) {
      const scopeIds = scopeIdsByMachineId.get(machineId) ?? [];
      scopeIds.push(scope.id);
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

  const groups = scopes.flatMap((scope) => {
    const instances = [...new Set(scope.machineIds)].flatMap((machineId) => {
      const memberships = scopeIdsByMachineId.get(machineId) ?? [];
      const instance = instancesById.get(machineId);
      return instance && memberships.length === 1 ? [instance] : [];
    });
    const group = machineGroup(scope, instances);
    return group ? [group] : [];
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
