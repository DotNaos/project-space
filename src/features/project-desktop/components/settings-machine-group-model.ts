import type { ConnectorInstallationRecord } from '@/shared/project-space-api';
import {
  connectorEnvironmentLabel,
  connectorRuntimeLabel
} from './machine-connector-topology-model';

export type SettingsConnectorChannel = 'dev' | 'stable';

export interface SettingsConnectorInstance {
  channel: SettingsConnectorChannel;
  id: string;
  isOnline: boolean;
  machine: ConnectorInstallationRecord;
  platformLabel?: string;
  runtimeLabel: string;
}

function connectorChannel(machine: ConnectorInstallationRecord): SettingsConnectorChannel {
  return machine.connector.profile?.channel === 'dev' &&
    machine.connector.profile.source === 'source'
    ? 'dev'
    : 'stable';
}

function connectorIsOnline(machine: ConnectorInstallationRecord) {
  return machine.connector.status === 'local' || machine.connector.status === 'online';
}

function connectorInstance(machine: ConnectorInstallationRecord): SettingsConnectorInstance {
  const channel = connectorChannel(machine);
  return {
    channel,
    id: machine.id,
    isOnline: connectorIsOnline(machine),
    machine,
    platformLabel: connectorEnvironmentLabel(machine),
    runtimeLabel: connectorRuntimeLabel(machine)
  };
}

function compareInstances(left: SettingsConnectorInstance, right: SettingsConnectorInstance) {
  const channelOrder = Number(left.channel === 'dev') - Number(right.channel === 'dev');
  if (channelOrder !== 0) return channelOrder;

  const onlineOrder = Number(right.isOnline) - Number(left.isOnline);
  return onlineOrder !== 0 ? onlineOrder : left.id.localeCompare(right.id);
}

export function settingsConnectorInstances(
  connectors: readonly ConnectorInstallationRecord[]
): SettingsConnectorInstance[] {
  return connectors.map(connectorInstance).sort(compareInstances);
}
