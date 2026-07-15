import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

import {
  getRegisteredConnectorDiscovery,
  getRegisteredConnectorMachines,
  getRegisteredConnectorRegistries,
  registerConnectorProjectRegistry
} from '../server/connector-hub';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

function registry(machineId: string, localProjectId: string): ConnectorProjectRegistryResult {
  return {
    checkedAt: new Date().toISOString(),
    connector: { machineId, machineName: machineId },
    discovery: {
      groups: [],
      projects: [
        {
          id: localProjectId,
          kind: 'standalone',
          name: localProjectId,
          rootPath: `/${machineId}/${localProjectId}`
        }
      ],
      rootItems: [
        {
          id: localProjectId,
          kind: 'project',
          label: localProjectId,
          projectId: localProjectId
        }
      ],
      rootPath: `/${machineId}`,
      structureViolations: []
    }
  };
}

function sourceDevelopmentRegistry(machineId: string) {
  const payload = registry(machineId, 'source-project');
  payload.connector.runtime = {
    architecture: 'x64',
    buildId: 'dev-source-checkout',
    bundleVersions: {
      connector: '0.4.7',
      machineTools: '0.4.7',
      projectCli: '0.4.7'
    },
    channel: 'dev',
    instanceId: 'dev-instance',
    lastCheckedAt: '2026-07-11T00:00:00.000Z',
    platform: 'linux',
    protocolVersion: '1',
    releaseId: 'dev-source-checkout',
    source: 'source',
    version: '0.4.7'
  };
  return payload;
}

describe('connector discovery ownership', () => {
  afterEach(() => setSystemTime());

  test('always namespaces connector IDs and retains structural machine ownership', async () => {
    await registerConnectorProjectRegistry(registry('collision-a', 'collision-b:project'));
    await registerConnectorProjectRegistry(registry('collision-a:collision-b', 'project'));

    const projects = (await getRegisteredConnectorDiscovery()).projects.filter((project) =>
      project.machineId?.startsWith('collision-a')
    );
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((project) => project.id)).size).toBe(2);
    expect(new Set(projects.map((project) => project.machineId))).toEqual(
      new Set(['collision-a', 'collision-a:collision-b'])
    );
  });

  test('requires a matching authenticated enrollment before accepting dev source metadata', async () => {
    const payload = sourceDevelopmentRegistry('bound-source-machine');
    await expect(registerConnectorProjectRegistry(payload)).rejects.toThrow(
      'bound enrollment profile'
    );
    await expect(
      registerConnectorProjectRegistry(payload, { channel: 'dev', source: 'source' })
    ).resolves.toBeUndefined();
    const projected = (await getRegisteredConnectorMachines()).find(
      (machine) => machine.id === 'bound-source-machine'
    );
    expect(projected?.connector.profile).toEqual({ channel: 'dev', source: 'source' });

    const mismatched = sourceDevelopmentRegistry('mismatched-source-machine');
    mismatched.connector.runtime = {
      ...mismatched.connector.runtime!,
      channel: 'beta'
    };
    await expect(
      registerConnectorProjectRegistry(mismatched, { channel: 'dev', source: 'source' })
    ).rejects.toThrow('does not match');
  });

  test('rejects a malformed refresh without replacing the last valid registry', async () => {
    const machineId = 'malformed-refresh-machine';
    await registerConnectorProjectRegistry(registry(machineId, 'good-project'));

    await expect(
      registerConnectorProjectRegistry({
        ...registry(machineId, 'replacement'),
        discovery: {
          ...registry(machineId, 'replacement').discovery,
          projects: [null]
        }
      } as unknown as ConnectorProjectRegistryResult)
    ).rejects.toThrow('invalid');

    const retained = (await getRegisteredConnectorRegistries()).find(
      (entry) => entry.registry.connector.machineId === machineId
    );
    expect(retained?.registry.discovery.projects[0]?.id).toBe('good-project');
  });

  test('rejects the reserved local kind from connector-controlled metadata', async () => {
    const payload = registry('untrusted-local-kind', 'project');
    payload.connector.kind = 'LoCaL';

    await expect(registerConnectorProjectRegistry(payload)).rejects.toThrow('invalid');
    expect(
      (await getRegisteredConnectorMachines()).some(
        (machine) => machine.id === 'untrusted-local-kind'
      )
    ).toBe(false);
  });

  test('rejects malformed battery metadata before it reaches the machine UI', async () => {
    const payload = registry('untrusted-battery', 'project');
    payload.connector.battery = { percentage: '100' } as unknown as {
      percentage: number;
    };

    await expect(registerConnectorProjectRegistry(payload)).rejects.toThrow('invalid');
  });

  test('does not materialize connector kind or network as execution metadata', async () => {
    const payload = registry('untrusted-execution-metadata', 'project');
    payload.connector.kind = 'linux';
    payload.connector.network = {
      localName: 'attacker.invalid',
      sshUser: 'root',
      tailscaleIp: '203.0.113.17'
    };
    await registerConnectorProjectRegistry(payload);

    const machine = (await getRegisteredConnectorMachines()).find(
      (entry) => entry.id === 'untrusted-execution-metadata'
    );
    expect(machine).toMatchObject({
      connector: { status: 'online' },
      kind: 'connector',
      network: {},
      sourcePath: 'connector-hub'
    });
  });

  test('keeps a stale machine and projects offline, then reconnects without duplication', async () => {
    const machineId = 'persistent-transition-machine';
    setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
    await registerConnectorProjectRegistry(registry(machineId, 'before-restart'));
    expect(
      (await getRegisteredConnectorMachines()).find((machine) => machine.id === machineId)
        ?.connector.status
    ).toBe('online');

    setSystemTime(new Date('2026-07-11T00:03:00.000Z'));
    const offlineMachines = (await getRegisteredConnectorMachines()).filter(
      (machine) => machine.id === machineId
    );
    expect(offlineMachines).toHaveLength(1);
    expect(offlineMachines[0]?.connector.status).toBe('offline');
    expect(
      (await getRegisteredConnectorDiscovery()).projects.some(
        (project) => project.machineId === machineId && project.name === 'before-restart'
      )
    ).toBe(true);

    await registerConnectorProjectRegistry(registry(machineId, 'after-reconnect'));
    const onlineMachines = (await getRegisteredConnectorMachines()).filter(
      (machine) => machine.id === machineId
    );
    expect(onlineMachines).toHaveLength(1);
    expect(onlineMachines[0]?.connector.status).toBe('online');
    expect(
      (await getRegisteredConnectorDiscovery()).projects.some(
        (project) => project.machineId === machineId && project.name === 'after-reconnect'
      )
    ).toBe(true);
  });
});
