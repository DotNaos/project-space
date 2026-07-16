import type {
  ConnectorInstallationRecord,
  PhysicalMachineRecord
} from '@/shared/project-space-api';
import { machineOsLabel } from './machine-platform-model';

export type ConnectorChannel = 'dev' | 'stable';

export interface ConnectorInstallationPresentation {
  channel: ConnectorChannel;
  environmentLabel?: string;
  executionScopeId?: string;
  id: string;
  isOnline: boolean;
  record: ConnectorInstallationRecord;
  runtimeLabel: string;
}

export interface PhysicalMachinePresentation {
  connectorCount: number;
  connectorIds: string[];
  connectors: ConnectorInstallationPresentation[];
  environmentLabels: string[];
  id: string;
  name: string;
  onlineConnectorCount: number;
}

export interface MachineConnectorTopologyConflict {
  connectorId: string;
  physicalMachineIds: string[];
}

export interface MachineConnectorTopology {
  conflicts: MachineConnectorTopologyConflict[];
  machines: PhysicalMachinePresentation[];
  ungroupedConnectors: ConnectorInstallationPresentation[];
}

function connectorChannel(record: ConnectorInstallationRecord): ConnectorChannel {
  return record.connector.profile?.channel === 'dev' &&
    record.connector.profile.source === 'source'
    ? 'dev'
    : 'stable';
}

function connectorIsOnline(record: ConnectorInstallationRecord) {
  return record.connector.status === 'local' || record.connector.status === 'online';
}

export function connectorEnvironmentLabel(record: ConnectorInstallationRecord) {
  const environment = record.environment;
  if (environment) {
    if (environment.kind === 'wsl') {
      return environment.label ? `WSL · ${environment.label}` : 'WSL';
    }
    if (environment.kind === 'macos') return 'macOS';
    if (environment.kind === 'windows') return 'Windows';
    if (environment.kind === 'linux') return environment.label || 'Linux';
  }

  return machineOsLabel(record);
}

export function connectorRuntimeLabel(record: ConnectorInstallationRecord) {
  const runtime = record.connector.runtime;
  if (runtime) {
    const source = runtime.source === 'source' ? 'Source checkout' : 'Managed release';
    const version = runtime.version || runtime.releaseId;
    return version
      ? `${source} · ${version.startsWith('v') ? version : `v${version}`}`
      : `${source} · Version not reported`;
  }

  if (record.connector.status === 'not-installed') return 'Connector not installed';
  if (record.connector.status === 'local') return 'Local Project Space connector';
  if (record.connector.status === 'offline') return 'Runtime details unavailable while offline';
  return 'Runtime details not reported';
}

export function connectorInstallationPresentation(
  record: ConnectorInstallationRecord
): ConnectorInstallationPresentation {
  return {
    channel: connectorChannel(record),
    environmentLabel: connectorEnvironmentLabel(record),
    executionScopeId: record.executionScopeId,
    id: record.id,
    isOnline: connectorIsOnline(record),
    record,
    runtimeLabel: connectorRuntimeLabel(record)
  };
}

export function connectorInstallationLabel(record: ConnectorInstallationRecord) {
  const presentation = connectorInstallationPresentation(record);
  const environment = presentation.environmentLabel || 'Unknown environment';
  const channel = presentation.channel === 'dev' ? 'Dev' : 'Stable';
  return `${environment} · ${channel} connector`;
}

export function connectorLocationPresentation({
  connector,
  physicalMachines
}: {
  connector: ConnectorInstallationRecord;
  physicalMachines: readonly PhysicalMachineRecord[];
}) {
  const memberships = physicalMachines.filter((machine) =>
    machine.connectorIds.includes(connector.id)
  );
  const presentation = connectorInstallationPresentation(connector);
  const connectorLabel = [
    presentation.environmentLabel || 'Environment not reported',
    presentation.channel === 'dev' ? 'Dev' : 'Stable'
  ].join(' · ');

  return {
    connectorLabel,
    machineName: memberships.length === 1 ? memberships[0]!.name : 'Ungrouped connector',
    statusLabel: `${connectorLabel} · ${connector.connector.status}`
  };
}

function compareConnectors(
  left: ConnectorInstallationPresentation,
  right: ConnectorInstallationPresentation
) {
  const environment = (left.environmentLabel || '').localeCompare(right.environmentLabel || '');
  if (environment !== 0) return environment;
  const channel = Number(left.channel === 'dev') - Number(right.channel === 'dev');
  if (channel !== 0) return channel;
  const online = Number(right.isOnline) - Number(left.isOnline);
  return online || left.id.localeCompare(right.id);
}

export function groupConnectorInstallations({
  connectors,
  physicalMachines
}: {
  connectors: readonly ConnectorInstallationRecord[];
  physicalMachines: readonly PhysicalMachineRecord[];
}): MachineConnectorTopology {
  const connectorsById = new Map(
    connectors.map((connector) => [connector.id, connectorInstallationPresentation(connector)])
  );
  const machineIdsByConnectorId = new Map<string, string[]>();

  for (const machine of physicalMachines) {
    for (const connectorId of new Set(machine.connectorIds)) {
      const machineIds = machineIdsByConnectorId.get(connectorId) ?? [];
      machineIds.push(machine.id);
      machineIdsByConnectorId.set(connectorId, machineIds);
    }
  }

  const conflicts: MachineConnectorTopologyConflict[] = [];
  const ungroupedConnectors: ConnectorInstallationPresentation[] = [];
  for (const connector of connectorsById.values()) {
    const machineIds = machineIdsByConnectorId.get(connector.id) ?? [];
    if (machineIds.length === 1) continue;
    ungroupedConnectors.push(connector);
    if (machineIds.length > 1) {
      conflicts.push({
        connectorId: connector.id,
        physicalMachineIds: [...machineIds].sort()
      });
    }
  }

  const machines = physicalMachines.map((machine) => {
    const grouped = [...new Set(machine.connectorIds)]
      .flatMap((connectorId) => {
        const membership = machineIdsByConnectorId.get(connectorId) ?? [];
        const connector = connectorsById.get(connectorId);
        return connector && membership.length === 1 ? [connector] : [];
      })
      .sort(compareConnectors);

    return {
      connectorCount: grouped.length,
      connectorIds: [...new Set(machine.connectorIds)],
      connectors: grouped,
      environmentLabels: [...new Set(grouped.flatMap((connector) => (
        connector.environmentLabel ? [connector.environmentLabel] : []
      )))],
      id: machine.id,
      name: machine.name,
      onlineConnectorCount: grouped.filter((connector) => connector.isOnline).length
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  return {
    conflicts: conflicts.sort((left, right) => left.connectorId.localeCompare(right.connectorId)),
    machines,
    ungroupedConnectors: ungroupedConnectors.sort(compareConnectors)
  };
}
