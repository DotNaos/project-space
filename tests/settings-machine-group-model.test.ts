import { describe, expect, test } from 'bun:test';
import type {
  ConnectorCredentialRecord,
  MachineExecutionScopeRecord,
  MachineRecord
} from '../src/shared/project-space-api';
import {
  groupSettingsMachines,
  safeConnectorOrigin
} from '../src/features/project-desktop/components/settings-machine-group-model';

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

function scope(id: string, machineIds: string[]): MachineExecutionScopeRecord {
  return { id, machineIds, name: id };
}

function credential(
  id: string,
  machineId: string | undefined,
  status: ConnectorCredentialRecord['status']
): ConnectorCredentialRecord {
  return {
    createdAt: '2026-07-15T00:00:00.000Z',
    expiresAt: '2027-07-15T00:00:00.000Z',
    id,
    machineId,
    status
  };
}

describe('settings machine grouping model', () => {
  test('links only safe http origins without embedded credentials', () => {
    expect(safeConnectorOrigin('https://dev.example.test/path')).toBe('https://dev.example.test/path');
    expect(safeConnectorOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    expect(safeConnectorOrigin('https://user:secret@example.test')).toBeUndefined();
    expect(safeConnectorOrigin('data:text/html,unsafe')).toBeUndefined();
    expect(safeConnectorOrigin('not a url')).toBeUndefined();
  });

  test('groups stable and dev connector identities only through one explicit execution scope', () => {
    const stable = machine({ id: 'stable-id', name: 'same display name' });
    const dev = machine({
      channel: 'dev',
      id: 'dev-id',
      name: 'totally unrelated display name',
      platform: 'linux'
    });

    const result = groupSettingsMachines({
      machines: [dev, stable],
      scopes: [scope('physical-os-pc', ['stable-id', 'dev-id', 'stable-id'])]
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      archivedConnectorCount: 0,
      connectorCount: 2,
      id: 'physical-os-pc',
      machineIds: ['stable-id', 'dev-id'],
      onlineConnectorCount: 2,
      platformLabels: ['Windows', 'Linux']
    });
    expect(result.groups[0]?.instances.map(({ channel, channelLabel, id }) => ({
      channel,
      channelLabel,
      id
    }))).toEqual([
      { channel: 'stable', channelLabel: 'Stable', id: 'stable-id' },
      { channel: 'dev', channelLabel: 'Dev', id: 'dev-id' }
    ]);
  });

  test('never groups matching names and never infers dev from display or runtime text', () => {
    const nameOnlyDev = machine({ id: 'one', name: 'os-pc-dev' });
    nameOnlyDev.connector.runtime!.channel = 'dev';
    nameOnlyDev.connector.runtime!.source = 'source';
    const matchingName = machine({ id: 'two', name: 'os-pc-dev' });

    const result = groupSettingsMachines({ machines: [nameOnlyDev, matchingName], scopes: [] });

    expect(result.groups).toEqual([]);
    expect(result.unscopedInstances.map(({ channel, id }) => ({ channel, id }))).toEqual([
      { channel: 'stable', id: 'one' },
      { channel: 'stable', id: 'two' }
    ]);
  });

  test('keeps an offline connector primary unless credential evidence proves it historical', () => {
    const temporarilyOffline = machine({ id: 'offline-current', status: 'offline' });
    const revokedDuplicate = machine({ id: 'offline-revoked', status: 'offline' });

    const result = groupSettingsMachines({
      credentials: [
        credential('credential-current', temporarilyOffline.id, 'active'),
        credential('credential-old', revokedDuplicate.id, 'revoked')
      ],
      machines: [revokedDuplicate, temporarilyOffline],
      scopes: [scope('physical-os-pc', [temporarilyOffline.id, revokedDuplicate.id])]
    });

    expect(result.groups[0]?.instances.map(({ id }) => id)).toEqual(['offline-current']);
    expect(result.groups[0]?.archivedInstances.map(({ id }) => id)).toEqual(['offline-revoked']);
    expect(result.groups[0]).toMatchObject({
      archivedConnectorCount: 1,
      connectorCount: 1,
      onlineConnectorCount: 0
    });
  });

  test('fails ambiguous scope membership closed and exposes unmatched credential evidence', () => {
    const conflicted = machine({ id: 'conflicted' });
    const result = groupSettingsMachines({
      credentials: [credential('orphan', 'removed-machine', 'revoked')],
      machines: [conflicted],
      scopes: [scope('scope-a', [conflicted.id]), scope('scope-b', [conflicted.id])]
    });

    expect(result.groups).toEqual([]);
    expect(result.unscopedInstances.map(({ id }) => id)).toEqual(['conflicted']);
    expect(result.scopeConflicts).toEqual([
      { machineId: 'conflicted', scopeIds: ['scope-a', 'scope-b'] }
    ]);
    expect(result.unmatchedCredentials.map(({ id }) => id)).toEqual(['orphan']);
  });
});
