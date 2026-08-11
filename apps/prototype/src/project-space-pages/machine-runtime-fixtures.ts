import type {
  ConnectorCredentialRecord,
  ConnectorInstallationRecord,
  PhysicalMachineRecord
} from '../../../../src/shared/project-space-api';

const checkedAt = '2026-08-10T12:00:00.000Z';

function managedConnector({
  id,
  name,
  status,
  update
}: {
  id: string;
  name: string;
  status: 'offline' | 'online';
  update: ConnectorInstallationRecord['connector']['update'];
}): ConnectorInstallationRecord {
  return {
    connector: {
      capabilities: [
        'codex.app-server-daemon.v1',
        'runtime.restart',
        'runtime.update'
      ],
      daemon: {
        appServerVersion: '0.145.0',
        authenticated: true,
        backend: 'pid',
        checkedAt,
        cliVersion: '0.145.0',
        compatible: true,
        installed: true,
        managedCodexVersion: '0.145.0',
        paired: true,
        reachable: true,
        remoteControlEnabled: true,
        remoteControlState: 'connected',
        running: true,
        state: 'ready'
      },
      installCommand: 'project connector install',
      lastSeen: checkedAt,
      origin: `https://${id}.example.test`,
      runtime: {
        architecture: 'x64',
        buildId: 'project-space-v0.18.0-linux-x64',
        bundleVersions: {
          connector: '0.18.0',
          machineTools: '0.18.0',
          projectCli: '0.18.0'
        },
        channel: 'stable',
        instanceId: `${id}-instance`,
        lastCheckedAt: checkedAt,
        platform: 'linux',
        protocolVersion: '1',
        releaseId: 'project-space-v0.18.0',
        source: 'managed',
        version: '0.18.0'
      },
      serviceName: 'project-space-connector.service',
      status,
      update
    },
    id,
    kind: 'desktop',
    name,
    network: {
      sshUser: 'oli',
      tailscaleIp: status === 'online' ? '100.64.0.10' : undefined
    },
    os: {
      family: 'Ubuntu',
      version: '24.04'
    },
    roles: ['connector'],
    sourcePath: 'prototype fixture'
  };
}

const availableUpdate = {
  availableCapabilities: ['codex.runtime.version.0.146.0'],
  availableReleaseId: 'project-space-v0.19.0',
  availableVersion: '0.19.0',
  lastCheckedAt: checkedAt,
  state: 'update-available' as const
};

export const machineRuntimePrototypeConnectors: ConnectorInstallationRecord[] = [
  managedConnector({
    id: 'connector-os-pc-linux',
    name: 'connector-7f6a2c',
    status: 'online',
    update: availableUpdate
  }),
  managedConnector({
    id: 'connector-os-pc-windows',
    name: 'connector-a9d144',
    status: 'online',
    update: {
      ...availableUpdate,
      lastFailure: {
        at: checkedAt,
        code: 'codex-waiting-approval',
        message: 'Waiting for a running Codex task to finish its approval.',
        rollbackAvailable: true
      },
      operation: {
        createdAt: checkedAt,
        expectedBuildId: 'project-space-v0.19.0-windows-x64',
        expectedReleaseId: 'project-space-v0.19.0',
        id: 'runtime-update-os-pc-windows',
        lastFailure: {
          at: checkedAt,
          code: 'codex-waiting-approval',
          message: 'Waiting for a running Codex task to finish its approval.',
          rollbackAvailable: true
        },
        machineId: 'connector-os-pc-windows',
        operation: 'update',
        requestedByUserId: 'prototype-owner',
        state: 'queued',
        updatedAt: checkedAt
      },
      state: 'update-pending'
    }
  }),
  managedConnector({
    id: 'connector-yoga-linux',
    name: 'connector-2df198',
    status: 'offline',
    update: availableUpdate
  }),
  managedConnector({
    id: 'connector-archived-linux',
    name: 'connector-archived',
    status: 'offline',
    update: availableUpdate
  }),
  managedConnector({
    id: 'connector-identity-conflict',
    name: 'connector-conflict',
    status: 'online',
    update: availableUpdate
  })
];

export const machineRuntimePrototypeCredentials: ConnectorCredentialRecord[] = [
  {
    createdAt: '2026-06-01T12:00:00.000Z',
    expiresAt: '2027-06-01T12:00:00.000Z',
    id: 'credential-archived-linux',
    machineId: 'connector-archived-linux',
    revokedAt: '2026-08-01T12:00:00.000Z',
    status: 'revoked'
  }
];

export const machineRuntimePrototypePhysicalMachines: PhysicalMachineRecord[] = [
  {
    connectorIds: [
      'connector-os-pc-linux',
      'connector-os-pc-windows',
      'connector-archived-linux'
    ],
    id: 'physical-os-pc',
    name: 'os-pc'
  },
  {
    connectorIds: ['connector-yoga-linux', 'connector-identity-conflict'],
    id: 'physical-os-yoga',
    name: 'os-yoga-unix'
  },
  {
    connectorIds: ['connector-identity-conflict'],
    id: 'physical-conflicting-record',
    name: 'conflicting machine record'
  }
];
