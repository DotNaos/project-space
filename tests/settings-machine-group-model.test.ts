import { describe, expect, test } from 'bun:test';
import type { MachineRecord } from '../src/shared/project-space-api';
import { settingsConnectorInstances } from '../src/features/project-desktop/components/settings-machine-group-model';

function machine({
  channel = 'stable',
  id,
  name = id,
  platform = 'windows',
  status = 'online'
}: {
  channel?: 'dev' | 'stable';
  id: string;
  name?: string;
  platform?: 'darwin' | 'linux' | 'windows';
  status?: MachineRecord['connector']['status'];
}): MachineRecord {
  return {
    connector: {
      installCommand: 'project connector install',
      profile: channel === 'dev' ? { channel: 'dev', source: 'source' } : undefined,
      runtime: {
        architecture: 'x64',
        buildId: '0'.repeat(40),
        bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
        channel,
        instanceId: `instance-${id}`,
        lastCheckedAt: '2026-07-15T00:00:00.000Z',
        platform,
        protocolVersion: '2',
        releaseId: 'v1.0.0',
        source: channel === 'dev' ? 'source' : 'managed',
        version: '1.0.0'
      },
      status
    },
    id,
    kind: 'connector',
    name,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

describe('settings connector instance model', () => {
  test('keeps canonical machine instances ordered by channel and connectivity', () => {
    const instances = settingsConnectorInstances([
      machine({ channel: 'dev', id: 'dev-offline', status: 'offline' }),
      machine({ channel: 'stable', id: 'stable-online' }),
      machine({ channel: 'dev', id: 'dev-online' })
    ]);

    expect(instances.map(({ channel, id, isOnline }) => ({ channel, id, isOnline }))).toEqual([
      { channel: 'stable', id: 'stable-online', isOnline: true },
      { channel: 'dev', id: 'dev-online', isOnline: true },
      { channel: 'dev', id: 'dev-offline', isOnline: false }
    ]);
  });

  test('uses typed machine metadata for platform and runtime labels', () => {
    const local = machine({ id: 'local-mac', platform: 'darwin', status: 'local' });
    local.connector.runtime = undefined;
    local.kind = 'darwin';
    const ubuntu = machine({ id: 'ubuntu', platform: 'linux', status: 'not-installed' });
    ubuntu.connector.runtime = undefined;
    ubuntu.kind = 'laptop';
    ubuntu.os = { family: 'ubuntu' };
    const [localMac, uninstalledUbuntu] = settingsConnectorInstances([
      local,
      ubuntu
    ]);

    expect(localMac).toMatchObject({
      id: 'local-mac',
      isOnline: true,
      platformLabel: 'macOS',
      runtimeLabel: 'Local Project Space connector'
    });
    expect(uninstalledUbuntu).toMatchObject({
      id: 'ubuntu',
      isOnline: false,
      platformLabel: 'Ubuntu',
      runtimeLabel: 'Connector not installed'
    });
  });
});
