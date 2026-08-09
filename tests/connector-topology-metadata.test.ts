import { afterEach, describe, expect, test } from 'bun:test';

import {
  isConnectorProjectRegistryPayload
} from '../server/connector-command-protocol';
import {
  getRegisteredConnectorMachines,
  registerConnectorProjectRegistry
} from '../server/connector-hub';
import {
  isConnectorEnvironmentRecord,
  loadConnectorTopologyMetadata
} from '../server/connector-topology-metadata';
import { getConnectorOverview } from '../server/local-machine-registry';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

const originalScopeOverride = process.env.PROJECT_CONNECTOR_EXECUTION_SCOPE_ID;

function registry(machineId: string): ConnectorProjectRegistryResult {
  return {
    checkedAt: '2026-07-17T00:00:00.000Z',
    connector: { machineId, machineName: machineId },
    discovery: {
      groups: [],
      projects: [],
      rootItems: [],
      rootPath: '/projects',
      structureViolations: []
    }
  };
}

afterEach(() => {
  if (originalScopeOverride === undefined) {
    delete process.env.PROJECT_CONNECTOR_EXECUTION_SCOPE_ID;
  } else {
    process.env.PROJECT_CONNECTOR_EXECUTION_SCOPE_ID = originalScopeOverride;
  }
});

describe('connector topology metadata', () => {
  test('gives stable and dev connectors in the same WSL environment the same scope', () => {
    const machineId = '0123456789abcdef0123456789abcdef';
    const stable = loadConnectorTopologyMetadata({
      environment: { PROJECT_CONNECTOR_CHANNEL: 'stable', WSL_DISTRO_NAME: 'Ubuntu-24.04' },
      platform: 'linux',
      readMachineId: () => machineId
    });
    const dev = loadConnectorTopologyMetadata({
      environment: { PROJECT_CONNECTOR_CHANNEL: 'dev', WSL_DISTRO_NAME: 'Ubuntu-24.04' },
      platform: 'linux',
      readMachineId: () => machineId
    });

    expect({ ...stable, compute: stable.compute && { ...stable.compute, resources: undefined } })
      .toEqual({ ...dev, compute: dev.compute && { ...dev.compute, resources: undefined } });
    expect(stable.environment).toEqual({ kind: 'wsl', label: 'Ubuntu-24.04' });
    expect(stable.executionScopeId).toMatch(/^scope-[a-f0-9]{40}$/);
    expect(stable.compute).toMatchObject({
      environmentKind: 'wsl',
      hostResolution: expect.stringMatching(/^(unresolved|verified)$/),
      platformKind: 'local'
    });
  });

  test('keeps native Linux and WSL as separate typed scopes', () => {
    const machineId = '0123456789abcdef0123456789abcdef';
    const linux = loadConnectorTopologyMetadata({
      environment: {},
      platform: 'linux',
      readMachineId: () => machineId
    });
    const wsl = loadConnectorTopologyMetadata({
      environment: { WSL_DISTRO_NAME: 'Ubuntu' },
      platform: 'linux',
      readMachineId: () => machineId
    });

    expect(linux.environment).toEqual({ kind: 'linux' });
    expect(wsl.environment).toEqual({ kind: 'wsl', label: 'Ubuntu' });
    expect(linux.executionScopeId).not.toBe(wsl.executionScopeId);
  });

  test('never infers WSL from a connector or host display name', () => {
    expect(loadConnectorTopologyMetadata({
      environment: {
        HOSTNAME: 'ubuntu-wsl',
        PROJECT_CONNECTOR_MACHINE_NAME: 'Windows WSL Dev'
      },
      platform: 'linux',
      readMachineId: () => '0123456789abcdef0123456789abcdef'
    }).environment).toEqual({ kind: 'linux' });
  });

  test('rejects an invalid override and leaves missing evidence undefined', () => {
    const metadata = loadConnectorTopologyMetadata({
      environment: { PROJECT_CONNECTOR_EXECUTION_SCOPE_ID: ' invalid scope ' },
      platform: 'aix',
      readMachineId: () => undefined
    });

    expect(metadata).toEqual({ environment: undefined, executionScopeId: undefined });
  });

  test('keeps the environment but omits a derived scope without a machine id', () => {
    expect(loadConnectorTopologyMetadata({
      environment: { WSL_DISTRO_NAME: 'Ubuntu' },
      platform: 'linux',
      readMachineId: () => undefined
    })).toEqual({
      environment: { kind: 'wsl', label: 'Ubuntu' },
      executionScopeId: undefined
    });
  });

  test('bounds optional environment labels', () => {
    expect(isConnectorEnvironmentRecord({ kind: 'wsl', label: 'Ubuntu' })).toBe(true);
    expect(isConnectorEnvironmentRecord({ kind: 'wsl', label: 'x'.repeat(129) })).toBe(false);
    expect(isConnectorEnvironmentRecord({ kind: 'wsl', label: 'Ubuntu\nspoofed' })).toBe(false);
  });

  test('validates the optional registry fields at the connector protocol boundary', () => {
    const valid = registry('topology-protocol');
    valid.connector.environment = { kind: 'windows', label: 'Windows 11' };
    valid.connector.executionScopeId = 'office-pc';
    valid.connector.daemon = {
      authenticated: true,
      checkedAt: '2026-07-17T00:00:00.000Z',
      compatible: true,
      environmentId: 'env_os_pc',
      installed: true,
      paired: true,
      reachable: true,
      remoteControlEnabled: true,
      remoteControlState: 'connected',
      running: true,
      state: 'ready'
    };
    expect(isConnectorProjectRegistryPayload(valid)).toBe(true);

    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: { ...valid.connector, environment: { kind: 'wsl', label: '' } }
    })).toBe(false);
    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: { ...valid.connector, executionScopeId: '../office-pc' }
    })).toBe(false);
    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: {
        ...valid.connector,
        daemon: { ...valid.connector.daemon, authenticated: false }
      }
    })).toBe(false);
  });

  test('preserves reported topology through the connector hub projection', async () => {
    const payload = registry('topology-hub-projection');
    payload.connector.environment = { kind: 'wsl', label: 'Ubuntu-24.04' };
    payload.connector.executionScopeId = 'scope-topology-hub';
    await registerConnectorProjectRegistry(payload);

    const projected = (await getRegisteredConnectorMachines()).find(
      (machine) => machine.id === 'topology-hub-projection'
    );
    expect(projected).toMatchObject({
      environment: { kind: 'wsl', label: 'Ubuntu-24.04' },
      executionScopeId: 'scope-topology-hub'
    });
  });

  test('adds explicit topology to the local connector overview', async () => {
    process.env.PROJECT_CONNECTOR_EXECUTION_SCOPE_ID = 'scope-local-overview';
    const overview = await getConnectorOverview();
    const local = overview.machines.find((machine) => machine.connector.status === 'local');

    expect(local?.environment?.kind).toMatch(/^(linux|macos|windows|wsl)$/);
    expect(local?.executionScopeId).toBe('scope-local-overview');
    expect(local?.compute?.resources?.cpu.cores).toBeGreaterThan(0);
  });

  test('classifies GitHub Codespaces as provider-managed environments', () => {
    const metadata = loadConnectorTopologyMetadata({
      environment: { CODESPACES: 'true', CODESPACE_NAME: 'example-space' },
      platform: 'linux',
      readMachineId: () => '0123456789abcdef0123456789abcdef'
    });
    expect(metadata.compute).toMatchObject({
      environmentKind: 'github_codespace',
      environmentName: 'example-space',
      hostResolution: 'not_applicable',
      platformKind: 'github_codespaces',
      platformName: 'GitHub Codespaces'
    });
  });
});
