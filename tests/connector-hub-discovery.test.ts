import { describe, expect, test } from 'bun:test';

import {
  getRegisteredConnectorDiscovery,
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
        { id: localProjectId, kind: 'project', label: localProjectId, projectId: localProjectId }
      ],
      rootPath: `/${machineId}`,
      structureViolations: []
    }
  };
}

describe('connector discovery ownership', () => {
  test('always namespaces connector IDs and retains structural machine ownership', () => {
    registerConnectorProjectRegistry(registry('collision-a', 'collision-b:project'));
    registerConnectorProjectRegistry(registry('collision-a:collision-b', 'project'));

    const projects = getRegisteredConnectorDiscovery().projects.filter((project) =>
      project.machineId?.startsWith('collision-a')
    );
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((project) => project.id)).size).toBe(2);
    expect(new Set(projects.map((project) => project.machineId))).toEqual(
      new Set(['collision-a', 'collision-a:collision-b'])
    );
  });

  test('rejects a malformed refresh without replacing the last valid registry', () => {
    const machineId = 'malformed-refresh-machine';
    registerConnectorProjectRegistry(registry(machineId, 'good-project'));

    expect(() =>
      registerConnectorProjectRegistry({
        ...registry(machineId, 'replacement'),
        discovery: {
          ...registry(machineId, 'replacement').discovery,
          projects: [null]
        }
      } as unknown as ConnectorProjectRegistryResult)
    ).toThrow('invalid');

    const retained = getRegisteredConnectorRegistries().find(
      (entry) => entry.registry.connector.machineId === machineId
    );
    expect(retained?.registry.discovery.projects[0]?.id).toBe('good-project');
  });
});
