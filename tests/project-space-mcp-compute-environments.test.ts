import { describe, expect, test } from 'bun:test';

import type { ConfiguredComputeInventoryResult } from '../server/configured-compute-inventory';
import { projectExecutionEnvironments } from '../server/project-space-mcp/compute-environments';
import { tools, toolSchemas } from '../server/project-space-mcp/tool-catalog';
import type { MachineRecord } from '../src/shared/project-space-api';

const checkedAt = '2026-08-09T08:00:00.000Z';

function inventory(
  overrides: Partial<ConfiguredComputeInventoryResult> = {}
): ConfiguredComputeInventoryResult {
  return {
    checkedAt,
    connectors: [],
    generations: new Map(),
    snapshot: {
      connectors: [],
      environments: [],
      hosts: [],
      platforms: [],
      violations: []
    },
    ...overrides
  };
}

describe('remote MCP execution Environment projection', () => {
  test('keeps a stopped hostless Codespace canonical without inventing a Host', () => {
    const result = projectExecutionEnvironments(inventory({
      snapshot: {
        connectors: [],
        environments: [{
          hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
          id: 'environment-codespace',
          identity: { key: 'account:private-codespace-identity', version: 1 },
          identityResolution: 'resolved',
          kind: 'github_codespace',
          name: 'project-space / task 533',
          platformId: 'platform-codespaces',
          resourceMode: 'dedicated'
        }],
        hosts: [],
        platforms: [{
          id: 'platform-codespaces',
          kind: 'github_codespaces',
          name: 'GitHub Codespaces'
        }],
        violations: []
      }
    }), {});

    expect(result.environments).toEqual([expect.objectContaining({
      hostAssociation: { evidence: 'provider', host: undefined, resolution: 'not_applicable' },
      id: 'environment-codespace',
      providerLifecycle: { state: 'unknown' },
      readiness: { state: 'unavailable' }
    })]);
    expect(JSON.stringify(result)).not.toContain('private-codespace-identity');
  });

  test('requires connector selection when two live channels serve one Environment', () => {
    const result = projectExecutionEnvironments(inventory({
      connectors: [connector('connector-a'), connector('connector-b')],
      generations: new Map([['connector-a', 1], ['connector-b', 2]]),
      snapshot: {
        connectors: [association('connector-a'), association('connector-b')],
        environments: [linuxEnvironment()],
        hosts: [],
        platforms: [localPlatform()],
        violations: []
      }
    }), { capability: 'codex.machine-tasks.v1' });

    expect(result.environments[0]).toMatchObject({
      readiness: {
        connectorIds: ['connector-a', 'connector-b'],
        state: 'connector_selection_required'
      }
    });
    expect(result.environments[0]?.connectors).toHaveLength(2);
  });

  test('surfaces identity and Host conflicts instead of selecting a connector', () => {
    const environment = linuxEnvironment();
    environment.identityResolution = 'conflict';
    environment.hostAssociation = { evidence: 'user', resolution: 'conflict' };
    const result = projectExecutionEnvironments(inventory({
      connectors: [connector('connector-a')],
      generations: new Map([['connector-a', 1]]),
      snapshot: {
        connectors: [association('connector-a')],
        environments: [environment],
        hosts: [],
        platforms: [localPlatform()],
        violations: [{ code: 'duplicate_environment_identity', id: 'private-identity-key' }]
      }
    }), {});

    expect(result).toMatchObject({
      environments: [{
        hostAssociation: { resolution: 'conflict' },
        identityState: 'conflict',
        readiness: { state: 'conflict' }
      }],
      inventoryState: 'conflict',
      violations: [{ code: 'duplicate_environment_identity' }]
    });
    expect(JSON.stringify(result)).not.toContain('private-identity-key');
  });

  test('keeps nested WSL and devbox topology with shared Host capacity', () => {
    const wsl = linuxEnvironment();
    wsl.id = 'environment-wsl';
    wsl.kind = 'wsl';
    wsl.name = 'WSL';
    wsl.resourceMode = 'exclusive';
    wsl.hostAssociation = {
      evidence: 'user',
      hostId: 'host-workstation',
      resolution: 'manual'
    };
    const devbox = linuxEnvironment();
    devbox.id = 'environment-devbox';
    devbox.kind = 'devbox';
    devbox.name = 'Devbox';
    devbox.parentEnvironmentId = wsl.id;
    devbox.resourceMode = 'shared';
    devbox.hostAssociation = wsl.hostAssociation;
    const result = projectExecutionEnvironments(inventory({
      snapshot: {
        connectors: [],
        environments: [wsl, devbox],
        hosts: [{
          id: 'host-workstation',
          identity: { key: 'account:private-host-identity', version: 1 },
          name: 'Workstation',
          platformId: 'platform-local'
        }],
        platforms: [localPlatform()],
        violations: []
      }
    }), {});

    expect(result.environments).toEqual([
      expect.objectContaining({
        capacity: { ownerId: 'host:host-workstation', state: 'unknown' },
        hostAssociation: {
          evidence: 'user',
          host: { id: 'host-workstation', name: 'Workstation', resources: undefined },
          resolution: 'manual'
        },
        id: 'environment-devbox',
        parentEnvironmentId: 'environment-wsl'
      }),
      expect.objectContaining({
        capacity: { ownerId: 'host:host-workstation', state: 'unknown' },
        id: 'environment-wsl'
      })
    ]);
    expect(JSON.stringify(result)).not.toContain('private-host-identity');
  });

  test('fails closed without traversing a conflicted parent cycle', () => {
    const first = linuxEnvironment();
    first.id = 'environment-a';
    first.parentEnvironmentId = 'environment-b';
    first.resourceMode = 'shared';
    const second = linuxEnvironment();
    second.id = 'environment-b';
    second.parentEnvironmentId = 'environment-a';
    second.resourceMode = 'shared';
    const result = projectExecutionEnvironments(inventory({
      connectors: [connector('connector-a')],
      generations: new Map([['connector-a', 1]]),
      snapshot: {
        connectors: [{
          associatedAt: checkedAt,
          connectorId: 'connector-a',
          environmentId: first.id
        }],
        environments: [first, second],
        hosts: [],
        platforms: [localPlatform()],
        violations: [{ code: 'environment_parent_cycle', id: first.id }]
      }
    }), {});

    expect(result).toMatchObject({
      environments: [
        { capacity: { ownerId: undefined }, readiness: { state: 'conflict' } },
        { capacity: { ownerId: undefined }, readiness: { state: 'conflict' } }
      ],
      inventoryState: 'conflict'
    });
  });

  test('filters only on capabilities reported by a live connector', () => {
    const offline = connector('connector-a');
    offline.connector.status = 'offline';
    const result = projectExecutionEnvironments(inventory({
      connectors: [offline],
      snapshot: {
        connectors: [association('connector-a')],
        environments: [linuxEnvironment()],
        hosts: [],
        platforms: [localPlatform()],
        violations: []
      }
    }), { capability: 'codex.machine-tasks.v1' });

    expect(result.environments).toEqual([]);
  });

  test('does not call an online connector ready without a current generation', () => {
    const result = projectExecutionEnvironments(inventory({
      connectors: [connector('connector-a')],
      snapshot: {
        connectors: [association('connector-a')],
        environments: [linuxEnvironment()],
        hosts: [],
        platforms: [localPlatform()],
        violations: []
      }
    }), {});

    expect(result.environments[0]).toMatchObject({
      agentRuntimes: [{ state: 'stale_connector' }],
      readiness: { state: 'stale_connector' }
    });
  });

  test('keeps execution checking when agent evidence is absent', () => {
    const result = projectExecutionEnvironments(inventory({
      connectors: [connector('connector-a')],
      generations: new Map([['connector-a', 1]]),
      snapshot: {
        connectors: [association('connector-a')],
        environments: [linuxEnvironment()],
        hosts: [],
        platforms: [localPlatform()],
        violations: []
      }
    }), {});

    expect(result.environments[0]).toMatchObject({
      readiness: {
        pendingEvidence: ['agent_runtime', 'agent_authorization', 'workspace', 'capacity'],
        selectedConnectorId: 'connector-a',
        state: 'checking'
      }
    });
  });

  test('does not accept stale daemon evidence as runtime or authorization readiness', () => {
    const machine = connector('connector-a');
    machine.connector.daemon = {
      authenticated: true,
      checkedAt: '2026-08-08T08:00:00.000Z',
      cliVersion: '1.0.0',
      compatible: true,
      installed: true,
      paired: false,
      reachable: true,
      remoteControlEnabled: false,
      remoteControlState: 'disabled',
      running: true,
      state: 'ready'
    };
    const result = projectExecutionEnvironments(inventory({
      connectors: [machine],
      generations: new Map([['connector-a', 1]]),
      snapshot: {
        connectors: [association('connector-a')],
        environments: [linuxEnvironment()],
        hosts: [],
        platforms: [localPlatform()],
        violations: []
      }
    }), {});

    expect(result.environments[0]).toMatchObject({
      agentRuntimes: [{
        authorization: { state: 'unknown' },
        state: 'stale_evidence'
      }],
      readiness: {
        pendingEvidence: ['agent_runtime', 'agent_authorization', 'workspace', 'capacity'],
        state: 'checking'
      }
    });
  });

  test('rejects ambiguous Environment and physical-machine compatibility selectors', () => {
    expect(toolSchemas.start_codex_task.safeParse({
      environmentId: 'environment-linux',
      physicalMachineId: 'physical-linux',
      repositoryId: 'DotNaos/project-space',
      task: 533
    }).success).toBe(false);
    expect(toolSchemas.start_codex_task.safeParse({
      environmentId: 'environment-linux',
      repositoryId: 'DotNaos/project-space',
      task: 533
    }).success).toBe(true);
    expect(toolSchemas.start_codex_task.safeParse({
      physicalMachineId: 'physical-linux',
      physicalMachineName: 'Linux',
      repositoryId: 'DotNaos/project-space',
      task: 533
    }).success).toBe(true);
    expect(tools.find(({ name }) => name === 'start_codex_task')?.inputSchema).toMatchObject({
      allOf: [
        { not: { required: ['environmentId', 'physicalMachineId'] } },
        { not: { required: ['environmentId', 'physicalMachineName'] } }
      ]
    });
  });
});

function localPlatform() {
  return { id: 'platform-local', kind: 'local' as const, name: 'Local' };
}

function linuxEnvironment() {
  return {
    hostAssociation: { evidence: 'none' as const, resolution: 'unresolved' as const },
    id: 'environment-linux',
    identity: { key: 'account:private-linux-identity', version: 1 },
    identityResolution: 'resolved' as 'resolved' | 'conflict',
    kind: 'native_linux' as const,
    name: 'Linux',
    platformId: 'platform-local',
    resourceMode: 'dedicated' as const
  };
}

function association(connectorId: string) {
  return { associatedAt: checkedAt, connectorId, environmentId: 'environment-linux' };
}

function connector(id: string): MachineRecord {
  return {
    connector: {
      capabilities: ['codex.machine-tasks.v1'],
      installCommand: 'private install command',
      lastSeen: checkedAt,
      status: 'online' as const
    },
    environment: { kind: 'linux' as const, label: 'Linux' },
    id,
    kind: 'connector',
    name: id,
    network: { tailscaleIp: '100.64.0.1' },
    roles: ['codex'],
    sourcePath: '/private/source/path'
  };
}
